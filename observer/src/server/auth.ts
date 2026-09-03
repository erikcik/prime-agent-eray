import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WS_BEARER_PREFIX } from "../shared/ws.ts";

export function tokensEqual(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

export function bearerFromHeaders(req: IncomingMessage): string | undefined {
	const h = req.headers.authorization;
	if (!h) return undefined;
	const m = /^Bearer\s+(.+)$/i.exec(h.trim());
	return m?.[1]?.trim() || undefined;
}

/** Parse `Sec-WebSocket-Protocol: prime-observer.v1, bearer.<base64url(token)>`. */
export function bearerFromWsProtocols(protocolsHeader: string | undefined): string | undefined {
	if (!protocolsHeader) return undefined;
	for (const raw of protocolsHeader.split(",")) {
		const p = raw.trim();
		if (!p.startsWith(WS_BEARER_PREFIX)) continue;
		const encoded = p.slice(WS_BEARER_PREFIX.length);
		try {
			return Buffer.from(encoded, "base64url").toString("utf8");
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function encodeWsBearer(token: string): string {
	return `${WS_BEARER_PREFIX}${Buffer.from(token, "utf8").toString("base64url")}`;
}

export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
	if (!origin) return false;
	return allowed.has(origin.replace(/\/$/, ""));
}

export interface AuthPolicy {
	token: string | undefined;
	insecureLocal: boolean;
}

/** HTTP request authorized? (no token configured + insecure loopback mode => always yes) */
export function httpAuthorized(req: IncomingMessage, policy: AuthPolicy): boolean {
	if (!policy.token) return policy.insecureLocal;
	return tokensEqual(bearerFromHeaders(req), policy.token);
}

export function hasQueryToken(url: string): boolean {
	const q = url.indexOf("?");
	if (q === -1) return false;
	const params = new URLSearchParams(url.slice(q + 1));
	return params.has("token") || params.has("access_token");
}
