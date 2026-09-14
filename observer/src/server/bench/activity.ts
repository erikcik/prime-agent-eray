import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SessionEntry } from "../disk/sessions-reader.ts";
import { contentText } from "./snapshot.ts";
import { readJsonFile, writeJsonAtomic } from "./store.ts";

export interface SessionUserMessage {
	sessionFile: string;
	sessionId: string;
	cwd?: string;
	entry: SessionEntry;
	text: string;
}

export interface SessionTouch {
	sessionFile: string;
	sessionId: string;
	cwd?: string;
	/** Entries appended in this scan. */
	appended: number;
}

interface FileState {
	offset: number;
	sessionId: string;
	cwd?: string;
	lastActivityAt: string;
}

const MAX_READ = 64 * 1024 * 1024;

/**
 * Incremental tail reader over root session files. Only bytes appended since the last scan are
 * parsed, so a 13 MB session streaming tokens costs a few KB per change. A file seen for the first
 * time starts at its current end: history is never replayed as new activity. Offsets persist, so
 * messages written while the observer was down are still picked up after a restart.
 */
export class SessionActivity {
	private files: Record<string, FileState>;
	private saveTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly sessionsDir: string,
		private readonly statePath: string,
	) {
		this.files = readJsonFile<Record<string, FileState>>(statePath) ?? {};
	}

	isRootSessionFile(path: string): boolean {
		return path.endsWith(".jsonl") && resolve(dirname(path)) === resolve(this.sessionsDir);
	}

	knownFiles(): Array<{ sessionFile: string } & FileState> {
		return Object.entries(this.files).map(([sessionFile, s]) => ({ sessionFile, ...s }));
	}

	scan(paths: string[]): { users: SessionUserMessage[]; touches: SessionTouch[] } {
		const users: SessionUserMessage[] = [];
		const touches: SessionTouch[] = [];
		for (const path of new Set(paths.filter((p) => this.isRootSessionFile(p)))) {
			let size: number;
			let mtimeMs: number;
			try {
				const st = statSync(path);
				size = st.size;
				mtimeMs = st.mtimeMs;
			} catch {
				delete this.files[path];
				continue;
			}
			const known = this.files[path];
			if (!known) {
				const header = readHeader(path);
				// The file's own mtime, not "now": otherwise every old session looks active at boot.
				this.files[path] = { offset: size, sessionId: header?.id ?? basename(path, ".jsonl"), cwd: header?.cwd, lastActivityAt: new Date(mtimeMs).toISOString() };
				continue;
			}
			if (size < known.offset) {
				known.offset = size; // rewritten (e.g. migration); treat as seen
				continue;
			}
			if (size === known.offset) continue;
			const { lines, consumed } = readAppended(path, known.offset, size);
			known.offset += consumed;
			let appended = 0;
			for (const line of lines) {
				let e: SessionEntry;
				try {
					e = JSON.parse(line) as SessionEntry;
				} catch {
					continue;
				}
				if (e.type === "session") {
					known.sessionId = String((e as { id?: unknown }).id ?? known.sessionId);
					known.cwd = typeof (e as { cwd?: unknown }).cwd === "string" ? String((e as { cwd?: unknown }).cwd) : known.cwd;
					continue;
				}
				appended++;
				const m = e.type === "message" ? (e.message as { role?: string; content?: unknown } | undefined) : undefined;
				if (m?.role === "user") users.push({ sessionFile: path, sessionId: known.sessionId, cwd: known.cwd, entry: e, text: contentText(m.content) });
			}
			if (appended > 0) {
				known.lastActivityAt = new Date().toISOString();
				touches.push({ sessionFile: path, sessionId: known.sessionId, cwd: known.cwd, appended });
			}
		}
		this.scheduleSave();
		return { users, touches };
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			writeJsonAtomic(this.statePath, this.files);
		}, 2000);
		this.saveTimer.unref();
	}

	flush(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		writeJsonAtomic(this.statePath, this.files);
	}
}

function readHeader(path: string): { id?: string; cwd?: string } | undefined {
	const { lines } = readAppended(path, 0, Math.min(statSync(path).size, 64 * 1024), true);
	try {
		const h = JSON.parse(lines[0] ?? "") as { type?: string; id?: string; cwd?: string };
		return h.type === "session" ? h : undefined;
	} catch {
		return undefined;
	}
}

/** Complete lines between offset and size; a trailing partial line is left for the next scan. */
function readAppended(path: string, offset: number, size: number, allowPartial = false): { lines: string[]; consumed: number } {
	const length = Math.min(size - offset, MAX_READ);
	const buf = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, length, offset);
	} finally {
		closeSync(fd);
	}
	const lastNl = buf.lastIndexOf(0x0a);
	if (lastNl < 0) return allowPartial ? { lines: [buf.toString("utf8")], consumed: 0 } : { lines: [], consumed: 0 };
	const text = buf.subarray(0, lastNl).toString("utf8");
	return { lines: text.split("\n").filter(Boolean), consumed: lastNl + 1 };
}
