import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server/main.ts";
import { sanitizeUploadName, uniqueUploadPath } from "../src/server/http/uploads.ts";
import { materializeFixture } from "./fixture.ts";

const TOKEN = "upload-test-token-0123456789";
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let repoRoot: string;

beforeAll(async () => {
	const dir = materializeFixture();
	// Uploads land in the session cwd, which falls back to repoRoot when no session is given.
	repoRoot = mkdtempSync(join(tmpdir(), "observer-upload-root-"));
	server = await startServer({
		PRIME_OBSERVER_PORT: "0",
		PRIME_OBSERVER_TOKEN: TOKEN,
		PRIME_AGENT_CODING_AGENT_DIR: dir,
		PRIME_AGENT_DAEMON_SOCKET: `${dir}/no-such-daemon.sock`,
		PRIME_OBSERVER_DEPLOY_HOOK: `${dir}/no-hook.sh`,
		PRIME_OBSERVER_REPO_ROOT: repoRoot,
		PRIME_OBSERVER_MAX_UPLOAD_BYTES: "2048",
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await server.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

function upload(name: string, body: BodyInit, extra: Record<string, string> = {}): Promise<Response> {
	return fetch(`${base}/api/uploads`, {
		method: "POST",
		headers: { ...auth, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), ...extra },
		body,
	});
}

describe("sanitizeUploadName", () => {
	it("keeps a normal name, spaces and unicode included", () => {
		expect(sanitizeUploadName("brief final.pdf")).toBe("brief final.pdf");
		expect(sanitizeUploadName(encodeURIComponent("rapor çıktı.png"))).toBe("rapor çıktı.png");
	});
	it("strips any path, so an upload cannot escape the inbox", () => {
		expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeUploadName("/abs/secret.key")).toBe("secret.key");
		expect(sanitizeUploadName("C:\\Windows\\evil.exe")).toBe("evil.exe");
	});
	it("rejects names that are only dots or empty", () => {
		expect(sanitizeUploadName("..")).toBe("");
		expect(sanitizeUploadName("   ")).toBe("");
		expect(sanitizeUploadName(".hidden")).toBe("hidden");
	});
});

describe("uniqueUploadPath", () => {
	it("never clobbers an existing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "observer-unique-"));
		writeFileSync(join(dir, "a.txt"), "x");
		expect(uniqueUploadPath(dir, "a.txt")).toBe(join(dir, "a (2).txt"));
		writeFileSync(join(dir, "a (2).txt"), "x");
		expect(uniqueUploadPath(dir, "a.txt")).toBe(join(dir, "a (3).txt"));
	});
});

describe("POST /api/uploads", () => {
	it("requires auth", async () => {
		const res = await fetch(`${base}/api/uploads`, {
			method: "POST",
			headers: { "x-file-name": "x.txt" },
			body: "hello",
		});
		expect(res.status).toBe(401);
	});

	it("streams a file into the inbox and reports a cwd-relative path", async () => {
		const res = await upload("notes.txt", "hello pod");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; file: { path: string; bytes: number; absolute: string } };
		expect(body.ok).toBe(true);
		expect(body.file.path).toBe("inbox/notes.txt");
		expect(body.file.bytes).toBe(9);
		expect(readFileSync(body.file.absolute, "utf8")).toBe("hello pod");
	});

	it("does not clobber a second upload of the same name", async () => {
		await upload("dup.txt", "first");
		const res = await upload("dup.txt", "second");
		const body = (await res.json()) as { file: { path: string } };
		expect(body.file.path).toBe("inbox/dup (2).txt");
	});

	it("refuses a traversing name by writing into the inbox only", async () => {
		const res = await upload("../../escape.txt", "nope");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { path: string; absolute: string } };
		expect(body.file.path).toBe("inbox/escape.txt");
		expect(body.file.absolute.startsWith(join(repoRoot, "inbox"))).toBe(true);
		expect(existsSync(join(repoRoot, "..", "escape.txt"))).toBe(false);
	});

	it("rejects a missing file name", async () => {
		const res = await fetch(`${base}/api/uploads`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/octet-stream" },
			body: "x",
		});
		expect(res.status).toBe(422);
	});

	it("rejects an empty file rather than creating a zero-byte attachment", async () => {
		const res = await upload("empty.txt", "");
		expect(res.status).toBe(422);
		expect(existsSync(join(repoRoot, "inbox", "empty.txt"))).toBe(false);
	});

	// The regression that made ai-ceo-1's uploads look like a timeout: an oversize body must be
	// REJECTED PROMPTLY with a status, not left hanging while the client keeps writing.
	it("rejects an oversize body with 413 instead of hanging", async () => {
		const tooBig = "x".repeat(4096); // limit is 2048 in this fixture
		const res = await Promise.race([
			upload("big.bin", tooBig),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upload hung instead of returning 413")), 5000)),
		]);
		expect(res.status).toBe(413);
	});

	it("leaves no .part turds behind after a rejected upload", () => {
		const inbox = join(repoRoot, "inbox");
		const leftovers = readdirSync(inbox).filter((f) => f.endsWith(".part"));
		expect(leftovers).toEqual([]);
	});

	it("lists the inbox", async () => {
		const res = await fetch(`${base}/api/uploads`, { headers: auth });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { inbox: string; files: { path: string }[] };
		expect(body.inbox).toBe("inbox");
		expect(body.files.map((f) => f.path)).toContain("inbox/notes.txt");
	});
});
