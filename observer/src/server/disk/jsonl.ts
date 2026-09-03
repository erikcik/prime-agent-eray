import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

export interface JsonlReadResult<T = unknown> {
	entries: T[];
	badLines: number;
	bytes: number;
	mtimeMs: number;
}

/**
 * Read an entire JSONL file tolerantly. Lines are split on "\n" only (Prime Agent's format is
 * strict LF framing; never use readline, which also splits on U+2028/U+2029).
 */
export async function readJsonl<T = unknown>(path: string, maxBytes = 256 * 1024 * 1024): Promise<JsonlReadResult<T>> {
	const st = await stat(path);
	if (st.size > maxBytes) throw new Error(`JSONL too large: ${path} (${st.size} bytes > ${maxBytes})`);
	const entries: T[] = [];
	let badLines = 0;
	let carry = "";
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path, { encoding: "utf8" });
		stream.on("data", (chunk: string | Buffer) => {
			carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let idx = carry.indexOf("\n");
			while (idx !== -1) {
				const line = carry.slice(0, idx);
				carry = carry.slice(idx + 1);
				pushLine(line);
				idx = carry.indexOf("\n");
			}
		});
		stream.on("end", () => {
			if (carry.trim()) pushLine(carry);
			resolve();
		});
		stream.on("error", reject);
	});
	function pushLine(line: string): void {
		const t = line.trim();
		if (!t) return;
		try {
			entries.push(JSON.parse(t) as T);
		} catch {
			badLines++;
		}
	}
	return { entries, badLines, bytes: st.size, mtimeMs: st.mtimeMs };
}

/** Read only the first line (the session header) without loading the file. */
export async function readFirstJsonLine<T = unknown>(path: string, maxBytes = 64 * 1024): Promise<T | undefined> {
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(maxBytes);
		const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
		const text = buf.subarray(0, bytesRead).toString("utf8");
		const nl = text.indexOf("\n");
		const line = (nl === -1 ? text : text.slice(0, nl)).trim();
		if (!line) return undefined;
		try {
			return JSON.parse(line) as T;
		} catch {
			return undefined;
		}
	} finally {
		await fh.close();
	}
}

/** Tail the last `n` non-empty lines of a text file (bounded read from the end). */
export async function tailLines(path: string, n: number, maxBytes = 2 * 1024 * 1024): Promise<string[]> {
	const st = await stat(path);
	const start = Math.max(0, st.size - maxBytes);
	const fh = await open(path, "r");
	try {
		const len = st.size - start;
		const buf = Buffer.alloc(len);
		await fh.read(buf, 0, len, start);
		const lines = buf.toString("utf8").split("\n").filter((l) => l.length > 0);
		return lines.slice(-n);
	} finally {
		await fh.close();
	}
}

/** Small mtime+size keyed memo for parsed files. */
export class FileMemo<T> {
	private cache = new Map<string, { key: string; value: T }>();
	constructor(private readonly load: (path: string) => Promise<T>) {}
	async get(path: string): Promise<T> {
		const st = await stat(path);
		const key = `${st.size}:${st.mtimeMs}`;
		const hit = this.cache.get(path);
		if (hit && hit.key === key) return hit.value;
		const value = await this.load(path);
		this.cache.set(path, { key, value });
		return value;
	}
	invalidate(path?: string): void {
		if (path) this.cache.delete(path);
		else this.cache.clear();
	}
}
