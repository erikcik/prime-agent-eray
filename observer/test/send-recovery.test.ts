// Every restart shape that has actually broken sending on the pod, pinned as a test.
//
// The rule these enforce: a composer message must survive a restart, and must NEVER be
// delivered twice. Those two goals conflict on an ambiguous failure, which is exactly where
// a naive "retry on error" silently duplicates the operator's prompt.

import { describe, expect, it } from "vitest";
import { ApiError, OBSERVER_RESTARTING } from "../src/web/lib/api.ts";
import { type SendApi, messageLanded, sendWithRecovery } from "../src/web/lib/send.ts";

const BODY = "u can use subagents btw";

/** A fake observer whose prompt() fails according to a script, then succeeds. */
function makeApi(script: Array<Error | "ok">, opts: { landed?: string[] } = {}) {
	const calls = { prompt: 0, steer: 0, followUp: 0, resume: 0, messages: 0 };
	const delivered: string[] = [];
	const api: SendApi = {
		async prompt(_id, message) {
			const step = script[calls.prompt++] ?? "ok";
			if (step !== "ok") throw step;
			delivered.push(message);
		},
		async steer(_id, message) {
			calls.steer++;
			delivered.push(message);
		},
		async followUp(_id, message) {
			calls.followUp++;
			delivered.push(message);
		},
		async resumeSession() {
			calls.resume++;
			return { activeSessionId: "live-1" };
		},
		async messages() {
			calls.messages++;
			return { messages: (opts.landed ?? []).map((text) => ({ role: "user", content: [{ type: "text", text }] })) };
		},
	};
	return { api, calls, delivered };
}

const restarting = () => new ApiError(502, "The observer is restarting — retrying…", OBSERVER_RESTARTING);
const notLive = () => new ApiError(409, "session is not live; resume it first", "session_not_live");
const ambiguous5xx = () => new ApiError(502, "Observer unreachable (502)");
const networkDrop = () => new TypeError("Failed to fetch");

const noSleep = async () => {};
const base = { id: "s1", mode: "prompt" as const, body: BODY, sleep: noSleep };

describe("sendWithRecovery", () => {
	it("delivers straight through when nothing is wrong", async () => {
		const { api, calls, delivered } = makeApi(["ok"]);
		expect(await sendWithRecovery({ ...base, api })).toBe("direct");
		expect(calls.prompt).toBe(1);
		expect(calls.resume).toBe(0);
		expect(delivered).toEqual([BODY]);
	});

	// The state a pod restart leaves behind: session on disk, no worker.
	it("resumes an inactive session, then delivers exactly once", async () => {
		const { api, calls, delivered } = makeApi([notLive(), "ok"]);
		expect(await sendWithRecovery({ ...base, api })).toBe("resumed");
		expect(calls.resume).toBe(1);
		expect(delivered).toEqual([BODY]);
	});

	// The observer-down window during a Redeploy.
	it("retries through the proxy interstitial and delivers exactly once", async () => {
		const { api, calls, delivered } = makeApi([restarting(), restarting(), "ok"], { landed: [] });
		expect(await sendWithRecovery({ ...base, api })).toBe("retried");
		expect(calls.prompt).toBe(3);
		expect(delivered).toEqual([BODY]);
	});

	// Measured on the pod: the interstitial appears while the observer is alive and its
	// serverStartedAt is unchanged, so it does NOT prove the request was refused. If the message
	// did land, re-sending it would duplicate the operator's prompt.
	it("does NOT re-send after a proxy interstitial whose message had already landed", async () => {
		const { api, calls, delivered } = makeApi([restarting(), "ok"], { landed: [BODY] });
		expect(await sendWithRecovery({ ...base, api })).toBe("confirmed");
		expect(calls.prompt).toBe(1);
		expect(delivered).toEqual([]);
	});

	// THE important one: an ambiguous failure where the message actually arrived.
	it("does NOT re-send when an ambiguous 5xx had already delivered the message", async () => {
		const { api, calls, delivered } = makeApi([ambiguous5xx(), "ok"], { landed: [BODY] });
		expect(await sendWithRecovery({ ...base, api })).toBe("confirmed");
		// One attempt only: the second prompt() must never happen, or the operator sees a duplicate.
		expect(calls.prompt).toBe(1);
		expect(calls.messages).toBe(1);
		expect(delivered).toEqual([]);
	});

	it("does re-send when an ambiguous 5xx did not deliver", async () => {
		const { api, calls, delivered } = makeApi([ambiguous5xx(), "ok"], { landed: ["something else"] });
		expect(await sendWithRecovery({ ...base, api })).toBe("retried");
		expect(calls.prompt).toBe(2);
		expect(delivered).toEqual([BODY]);
	});

	it("treats a dropped connection (no status at all) as ambiguous, not fatal", async () => {
		const { api, delivered } = makeApi([networkDrop(), "ok"], { landed: [] });
		expect(await sendWithRecovery({ ...base, api })).toBe("retried");
		expect(delivered).toEqual([BODY]);
	});

	it("survives a restart that both kills the session and bounces the observer", async () => {
		// Ordering seen on the pod: proxy page first, then the session turns out to be inactive.
		const { api, calls, delivered } = makeApi([restarting(), notLive(), "ok"]);
		expect(await sendWithRecovery({ ...base, api })).toBe("resumed");
		expect(calls.resume).toBe(1);
		expect(delivered).toEqual([BODY]);
	});

	it("never retries a genuine application error", async () => {
		const { api, calls } = makeApi([new ApiError(400, "message is required")]);
		await expect(sendWithRecovery({ ...base, api })).rejects.toThrow("message is required");
		expect(calls.prompt).toBe(1);
		expect(calls.resume).toBe(0);
	});

	it("never retries a 404 for an unknown session", async () => {
		const { api, calls } = makeApi([new ApiError(404, "unknown session s1")]);
		await expect(sendWithRecovery({ ...base, api })).rejects.toThrow("unknown session");
		expect(calls.prompt).toBe(1);
	});

	it("surfaces a resume failure instead of looping on it", async () => {
		const { api } = makeApi([notLive(), "ok"]);
		api.resumeSession = async () => {
			throw new ApiError(409, "session has no file to resume");
		};
		await expect(sendWithRecovery({ ...base, api })).rejects.toThrow("no file to resume");
	});

	it("gives up when the budget is spent rather than retrying forever", async () => {
		const forever = Array.from({ length: 500 }, () => restarting());
		const { api, calls } = makeApi(forever);
		let clock = 0;
		const outcome = sendWithRecovery({
			...base,
			api,
			budgetMs: 30_000,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		await expect(outcome).rejects.toThrow();
		// Bounded: with 2s->8s backoff a 30s budget cannot allow anything like 500 attempts.
		expect(calls.prompt).toBeLessThan(15);
		expect(calls.prompt).toBeGreaterThan(2);
	});

	it("honours the budget for a session that never comes back live", async () => {
		const forever = Array.from({ length: 500 }, () => notLive());
		const { api, calls } = makeApi(forever);
		let clock = 0;
		await expect(
			sendWithRecovery({ ...base, api, budgetMs: 20_000, now: () => clock, sleep: async (ms) => { clock += ms; } }),
		).rejects.toThrow("not live");
		expect(calls.prompt).toBeLessThan(15);
	});

	it("routes steer and follow-up through the same recovery", async () => {
		const { api, delivered } = makeApi([]);
		expect(await sendWithRecovery({ ...base, api, mode: "steer" })).toBe("direct");
		expect(await sendWithRecovery({ ...base, api, mode: "followUp" })).toBe("direct");
		expect(delivered).toEqual([BODY, BODY]);
	});

	it("reports progress so the banner can explain the delay", async () => {
		const { api } = makeApi([restarting(), notLive(), "ok"]);
		const seen: string[] = [];
		await sendWithRecovery({ ...base, api, onStatus: (m) => seen.push(m) });
		expect(seen.some((m) => /unreachable|restarting|checking/i.test(m))).toBe(true);
		expect(seen.some((m) => /resuming/i.test(m))).toBe(true);
	});
});

describe("messageLanded", () => {
	it("matches our exact user message, ignoring surrounding whitespace", async () => {
		const { api } = makeApi([], { landed: [`  ${BODY}  `] });
		expect(await messageLanded(api, "s1", BODY)).toBe(true);
	});
	it("does not match a different message", async () => {
		const { api } = makeApi([], { landed: ["u can use subagents"] });
		expect(await messageLanded(api, "s1", BODY)).toBe(false);
	});
	it("does not match an assistant echo of the same text", async () => {
		const api = makeApi([]).api;
		api.messages = async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: BODY }] }] });
		expect(await messageLanded(api, "s1", BODY)).toBe(false);
	});
	it("reports not-landed when the transcript cannot be read, so the message is never dropped", async () => {
		const api = makeApi([]).api;
		api.messages = async () => {
			throw new Error("offline");
		};
		expect(await messageLanded(api, "s1", BODY)).toBe(false);
	});
});
