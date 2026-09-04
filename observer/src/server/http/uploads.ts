// Asset upload for the composer: the operator attaches a file, it lands in the session's
// `inbox/` folder, and the prompt announces it by path so the agent can open it with ipython.
//
// The transport is a RAW body plus an `X-File-Name` header, deliberately not multipart —
// carried over from ai-ceo-1's `/api/uploads`, where the lesson was learned the hard way:
//
//  * Never let an upload reach a JSON body reader. `Router`'s `ctx.body()` buffers the whole
//    request in memory and caps at 4 MB, so a 50 MB video would either 413 or balloon the heap.
//    This handler streams `req` straight to disk and never calls `ctx.body()`.
//  * ALWAYS drain (never destroy) the request when rejecting early. Leaving the body unread
//    fills the socket, the client blocks on a write nobody consumes, and the upload "hangs"
//    until a timeout instead of failing fast — the symptom that made ai-ceo-1's uploads look
//    like a timeout bug rather than a rejection. Destroying is the opposite mistake: it kills
//    the socket before the 413/422 is written, so the client sees a transport error with no
//    status. Both were observed here; only resume() gives the caller a real status.
//  * Node's own `server.requestTimeout` (300 s by default) aborts a large upload mid-flight on
//    a slow uplink, with no status — main.ts disables it and bounds size here instead.
//
// Writes go to a `.part` sibling first and are renamed only after the stream finishes, so an
// aborted upload can never leave a truncated file that looks complete to the agent.

import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { HttpError } from "./router.ts";

/** Where attachments land, relative to the session's cwd. Mirrors ai-ceo-1's `<workspace>/inbox/`. */
export const UPLOAD_INBOX_DIR = "inbox";

/** Default cap. Note: through the RunPod proxy Cloudflare rejects bodies over ~100 MB first. */
export const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export interface UploadedFile {
	name: string;
	/** cwd-relative, e.g. `inbox/brief.pdf` — this is what goes into the prompt. */
	path: string;
	absolute: string;
	bytes: number;
	modified_at: string;
}

/** Strip directories and anything that could escape the inbox. */
export function sanitizeUploadName(raw: string): string {
	let name = raw.trim();
	try {
		name = decodeURIComponent(name);
	} catch {
		// A literal '%' is fine; keep the raw value.
	}
	name = basename(name.replace(/\\/g, "/"));
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	name = name.replace(/[\u0000-\u001f\u007f]/g, "");
	name = name.replace(/[/\\:*?"<>|]/g, "_");
	name = name.replace(/^\.+/, "");
	name = name.trim();
	if (!name || name === "." || name === "..") return "";
	return name.slice(0, 180);
}

/** `brief.pdf` -> `brief (2).pdf` when taken, so an upload never silently clobbers an earlier one. */
export function uniqueUploadPath(dir: string, name: string): string {
	const target = join(dir, name);
	if (!existsSync(target)) return target;
	const ext = extname(name);
	const stem = ext ? name.slice(0, -ext.length) : name;
	for (let i = 2; i < 1000; i++) {
		const candidate = join(dir, `${stem} (${i})${ext}`);
		if (!existsSync(candidate)) return candidate;
	}
	return join(dir, `${stem}-${randomBytes(4).toString("hex")}${ext}`);
}

function record(absolute: string, bytes: number, mtimeMs: number): UploadedFile {
	return {
		name: basename(absolute),
		path: `${UPLOAD_INBOX_DIR}/${basename(absolute)}`,
		absolute,
		bytes,
		modified_at: new Date(mtimeMs).toISOString(),
	};
}

/**
 * Discard the rest of an incoming body before answering an error.
 *
 * `resume()` only — deliberately NOT `destroy()`. Destroying tears down the socket, so the
 * status we are about to send never reaches the client and fetch reports a bare
 * "other side closed"; the caller sees a transport failure instead of "413 too large".
 * Draining keeps the connection alive just long enough for the real status to be written,
 * which is the whole point: fail loudly and fast rather than looking like a timeout.
 */
function drain(req: IncomingMessage): void {
	req.resume();
}

export function listInbox(cwd: string): UploadedFile[] {
	const inbox = join(cwd, UPLOAD_INBOX_DIR);
	if (!existsSync(inbox)) return [];
	const files: UploadedFile[] = [];
	for (const entry of readdirSync(inbox, { withFileTypes: true })) {
		if (!entry.isFile() || entry.name.startsWith(".")) continue;
		const absolute = join(inbox, entry.name);
		const s = statSync(absolute);
		files.push(record(absolute, s.size, s.mtimeMs));
	}
	files.sort((a, b) => a.name.localeCompare(b.name));
	return files;
}

export interface ReceiveOptions {
	cwd: string;
	fileName: string | undefined;
	maxBytes?: number;
}

/** Stream one raw request body into `<cwd>/inbox/<name>`. Never buffers the file in memory. */
export async function receiveUpload(req: IncomingMessage, options: ReceiveOptions): Promise<UploadedFile> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
	const name = sanitizeUploadName(options.fileName ?? "");
	if (!name) {
		drain(req);
		throw new HttpError(422, "X-File-Name header with a usable file name is required", "bad_file_name");
	}
	const cwd = resolve(options.cwd);
	if (!existsSync(cwd)) {
		drain(req);
		throw new HttpError(400, `cwd does not exist: ${cwd}`, "missing_cwd");
	}

	const declared = req.headers["content-length"];
	if (typeof declared === "string" && declared.trim()) {
		if (!/^\d+$/.test(declared.trim())) {
			drain(req);
			throw new HttpError(400, "invalid content-length");
		}
		if (Number.parseInt(declared.trim(), 10) > maxBytes) {
			drain(req);
			throw new HttpError(413, `upload is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`, "too_large");
		}
	}

	const inbox = join(cwd, UPLOAD_INBOX_DIR);
	mkdirSync(inbox, { recursive: true });
	const target = uniqueUploadPath(inbox, name);
	const partial = join(inbox, `.${basename(target)}.${randomBytes(6).toString("hex")}.part`);

	const bytes = await new Promise<number>((resolveBytes, reject) => {
		let received = 0;
		let failed = false;
		// `wx` so two uploads can never race onto the same temp file.
		const out = createWriteStream(partial, { flags: "wx", mode: 0o644 });
		const fail = (error: Error): void => {
			if (failed) return;
			failed = true;
			out.destroy();
			try {
				rmSync(partial, { force: true });
			} catch {
				// The temp file may never have been created; nothing to clean up.
			}
			reject(error);
		};
		req.on("data", (chunk: Buffer) => {
			received += chunk.length;
			// A lying or absent content-length is caught here, mid-stream.
			if (received > maxBytes) {
				req.unpipe(out);
				req.resume(); // drain the rest so the 413 can still be delivered
				fail(new HttpError(413, `upload is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`, "too_large"));
			}
		});
		req.on("aborted", () => fail(new HttpError(499, "upload aborted by the client", "aborted")));
		req.on("error", fail);
		out.on("error", fail);
		out.on("finish", () => {
			if (!failed) resolveBytes(received);
		});
		req.pipe(out);
	});

	if (bytes === 0) {
		rmSync(partial, { force: true });
		throw new HttpError(422, "uploaded file is empty", "empty_file");
	}
	// Only now does the file become visible under its real name.
	renameSync(partial, target);
	const s = statSync(target);
	return record(target, bytes, s.mtimeMs);
}
