import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
	req: IncomingMessage;
	res: ServerResponse;
	params: Record<string, string>;
	query: URLSearchParams;
	url: URL;
	body<T = unknown>(): Promise<T>;
}

export type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
		readonly extra?: Record<string, unknown>,
	) {
		super(message);
	}
}

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: Handler;
}

/** Tiny method+pattern router over node:http. `:name` params, JSON in/out. */
export class Router {
	private routes: Route[] = [];

	add(method: string, path: string, handler: Handler): this {
		const keys: string[] = [];
		const source = path
			.split("/")
			.map((seg) => {
				if (seg.startsWith(":")) {
					keys.push(seg.slice(1));
					return "([^/]+)";
				}
				if (seg === "*") return "(.*)";
				return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			})
			.join("/");
		this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler });
		return this;
	}

	get(path: string, h: Handler): this {
		return this.add("GET", path, h);
	}
	post(path: string, h: Handler): this {
		return this.add("POST", path, h);
	}
	delete(path: string, h: Handler): this {
		return this.add("DELETE", path, h);
	}

	/** Returns false when no route matched (caller falls through to static serving). */
	async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const url = new URL(req.url ?? "/", "http://observer.local");
		for (const route of this.routes) {
			if (route.method !== req.method) continue;
			const m = route.pattern.exec(url.pathname);
			if (!m) continue;
			const params: Record<string, string> = {};
			route.keys.forEach((k, i) => {
				params[k] = decodeURIComponent(m[i + 1] ?? "");
			});
			const ctx: RouteContext = {
				req,
				res,
				params,
				query: url.searchParams,
				url,
				body: <T,>() => readJson<T>(req),
			};
			try {
				const result = await route.handler(ctx);
				if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
			} catch (error) {
				if (res.headersSent) {
					res.end();
					return true;
				}
				if (error instanceof HttpError) {
					sendJson(res, error.status, { error: error.message, code: error.code, ...(error.extra ?? {}) });
				} else {
					const e = error as { status?: number; code?: string; message?: string };
					const status = typeof e.status === "number" ? e.status : 500;
					sendJson(res, status, { error: e.message ?? String(error), code: e.code });
				}
			}
			return true;
		}
		return false;
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(data),
		"cache-control": "no-store",
	});
	res.end(data);
}

async function readJson<T>(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<T> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const b = chunk as Buffer;
		size += b.length;
		if (size > maxBytes) throw new HttpError(413, "request body too large");
		chunks.push(b);
	}
	if (chunks.length === 0) return {} as T;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
}
