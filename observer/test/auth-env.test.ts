import { describe, expect, it } from "vitest";
import { bearerFromWsProtocols, encodeWsBearer, hasQueryToken, originAllowed, tokensEqual } from "../src/server/auth.ts";
import { deriveAllowedOrigins, loadEnv } from "../src/server/env.ts";

describe("auth", () => {
	it("compares tokens in constant time semantics", () => {
		expect(tokensEqual("abc", "abc")).toBe(true);
		expect(tokensEqual("abc", "abd")).toBe(false);
		expect(tokensEqual(undefined, "abc")).toBe(false);
	});
	it("round-trips the WS bearer subprotocol", () => {
		const header = `prime-observer.v1, ${encodeWsBearer("s3cret-token-value")}`;
		expect(bearerFromWsProtocols(header)).toBe("s3cret-token-value");
		expect(bearerFromWsProtocols("prime-observer.v1")).toBeUndefined();
	});
	it("rejects query-string tokens", () => {
		expect(hasQueryToken("/api/fleet?token=x")).toBe(true);
		expect(hasQueryToken("/api/fleet?scope=live")).toBe(false);
	});
	it("checks origins against the allow-list", () => {
		const allowed = deriveAllowedOrigins({ RUNPOD_POD_ID: "abc123" } as NodeJS.ProcessEnv, 8790);
		expect(originAllowed("https://abc123-8790.proxy.runpod.net", allowed)).toBe(true);
		expect(originAllowed("http://localhost:8790", allowed)).toBe(true);
		expect(originAllowed("https://evil.example", allowed)).toBe(false);
		expect(originAllowed(undefined, allowed)).toBe(false);
	});
});

describe("env", () => {
	it("requires a token unless insecure loopback", () => {
		expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/PRIME_OBSERVER_TOKEN/);
		expect(() => loadEnv({ PRIME_OBSERVER_TOKEN: "short" } as NodeJS.ProcessEnv)).toThrow(/16/);
		const e = loadEnv({ PRIME_OBSERVER_INSECURE_LOCAL: "1" } as NodeJS.ProcessEnv);
		expect(e.token).toBeUndefined();
		expect(e.host).toBe("127.0.0.1");
		expect(() => loadEnv({ PRIME_OBSERVER_INSECURE_LOCAL: "1", PRIME_OBSERVER_HOST: "0.0.0.0" } as NodeJS.ProcessEnv)).toThrow();
	});
	it("derives agent dir and origins", () => {
		const e = loadEnv({
			PRIME_OBSERVER_TOKEN: "0123456789abcdef0123",
			PRIME_AGENT_CODING_AGENT_DIR: "/x/agent",
			PRIME_OBSERVER_PORT: "9000",
			PRIME_OBSERVER_ALLOWED_ORIGINS: "https://a.example/, https://b.example",
		} as NodeJS.ProcessEnv);
		expect(e.agentDir).toBe("/x/agent");
		expect(e.dataDir).toBe("/x/agent/observer");
		expect([...e.allowedOrigins]).toEqual(expect.arrayContaining(["https://a.example", "https://b.example", "http://localhost:9000"]));
	});
});
