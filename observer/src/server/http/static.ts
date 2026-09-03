import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
};

const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com data:",
	"img-src 'self' data: blob:",
	"connect-src 'self' ws: wss:",
	"frame-ancestors 'none'",
	"base-uri 'self'",
].join("; ");

/** Serve the built web app with SPA fallback. Hashed assets are immutable; index.html is never cached. */
export function serveStatic(webDist: string, req: IncomingMessage, res: ServerResponse): void {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405).end();
		return;
	}
	const root = resolve(webDist);
	const url = new URL(req.url ?? "/", "http://observer.local");
	let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
	if (rel === "/" || rel === "") rel = "/index.html";
	let file = join(root, rel);
	if (!file.startsWith(root)) {
		res.writeHead(403).end();
		return;
	}
	const isAsset = rel.startsWith("/assets/");
	if (!existsSync(file) || statSync(file).isDirectory()) {
		if (isAsset || extname(rel)) {
			res.writeHead(404, { "content-type": "text/plain" }).end("not found");
			return;
		}
		file = join(root, "index.html");
		if (!existsSync(file)) {
			res.writeHead(503, { "content-type": "text/plain" }).end("web UI not built: run `npm run build` in observer/");
			return;
		}
	}
	const type = TYPES[extname(file)] ?? "application/octet-stream";
	const headers: Record<string, string> = {
		"content-type": type,
		"cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
	};
	if (type.startsWith("text/html")) headers["content-security-policy"] = CSP;
	res.writeHead(200, headers);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	createReadStream(file).pipe(res);
}
