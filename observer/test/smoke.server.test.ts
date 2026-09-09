import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { encodeWsBearer } from "../src/server/auth.ts";
import { startServer } from "../src/server/main.ts";
import { materializeFixture } from "./fixture.ts";

const TOKEN = "smoke-test-token-0123456789";
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
	const dir = materializeFixture();
	server = await startServer({
		PRIME_OBSERVER_PORT: "0",
		PRIME_OBSERVER_TOKEN: TOKEN,
		PRIME_AGENT_CODING_AGENT_DIR: dir,
		PRIME_AGENT_DAEMON_SOCKET: `${dir}/no-such-daemon.sock`,
		PRIME_OBSERVER_DEPLOY_HOOK: `${dir}/no-hook.sh`,
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await server.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe("observer server (daemon offline)", () => {
	it("health is public and reports the daemon offline", async () => {
		const res = await fetch(`${base}/api/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; daemon: { state: string } };
		expect(body.ok).toBe(true);
		expect(["offline", "connecting"]).toContain(body.daemon.state);
	});
	it("rejects unauthenticated and query-token requests", async () => {
		expect((await fetch(`${base}/api/fleet`)).status).toBe(401);
		expect((await fetch(`${base}/api/fleet?token=${TOKEN}`)).status).toBe(400);
		expect((await fetch(`${base}/api/fleet`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
	});
	it("serves the fleet from disk", async () => {
		const res = await fetch(`${base}/api/fleet`, { headers: auth });
		expect(res.status).toBe(200);
		const tree = (await res.json()) as { live: boolean; roots: Array<{ sessionId: string; children: unknown[] }>; counts: { subagents: number } };
		expect(tree.live).toBe(false);
		const root = tree.roots.find((r) => r.sessionId === "01a0aaaa-0000-7000-8000-000000000001");
		expect(root?.children).toHaveLength(2);
		expect(tree.counts.subagents).toBe(2);
	});
	it("serves session detail, messages, harness, skills, comms, schedules", async () => {
		const id = "01a0aaaa-0000-7000-8000-000000000001";
		const detail = (await (await fetch(`${base}/api/sessions/${id}`, { headers: auth })).json()) as { live: boolean; agentStatus?: { summary: string }; artifacts?: { subagents: unknown[] } };
		expect(detail.live).toBe(false);
		expect(detail.agentStatus?.summary).toBe("Printed 1");
		expect(detail.artifacts?.subagents).toHaveLength(1);
		const msgs = (await (await fetch(`${base}/api/sessions/${id}/messages?limit=2`, { headers: auth })).json()) as { total: number; hasMore: boolean; source: string };
		expect(msgs.total).toBe(3);
		expect(msgs.hasMore).toBe(true);
		expect(msgs.source).toBe("disk");
		const harness = (await (await fetch(`${base}/api/harness?session=${id}`, { headers: auth })).json()) as { merged: { entries: { memory: Record<string, unknown> } }; history: unknown[] };
		expect(Object.keys(harness.merged.entries.memory).sort()).toEqual(["global:mem-1", "local:mem-1"]);
		expect(harness.history).toHaveLength(2);
		const skills = (await (await fetch(`${base}/api/skills`, { headers: auth })).json()) as { skills: Array<{ name: string }> };
		expect(skills.skills.some((s) => s.name === "hello-skill")).toBe(true);
		const doc = (await (await fetch(`${base}/api/skills/hello-skill/doc`, { headers: auth })).json()) as { markdown: string };
		expect(doc.markdown).toContain("# Hello");
		const comms = (await (await fetch(`${base}/api/comms`, { headers: auth })).json()) as { records: Array<{ text: string }> };
		expect(comms.records[0]?.text).toBe("child says done");
		const sched = (await (await fetch(`${base}/api/schedules`, { headers: auth })).json()) as { offline: Array<{ jobs: unknown[] }> };
		expect(sched.offline[0]?.jobs).toHaveLength(1);
	});
	it("returns 503/409 for live-only actions while offline", async () => {
		const id = "01a0aaaa-0000-7000-8000-000000000001";
		const res = await fetch(`${base}/api/sessions/${id}/abort`, { method: "POST", headers: auth });
		expect([409, 503]).toContain(res.status);
		const points = await fetch(`${base}/api/sessions/${id}/rewind-points`, { headers: auth });
		expect([409, 503]).toContain(points.status);
		const rewind = await fetch(`${base}/api/sessions/${id}/rewind`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ entryId: "x" }) });
		expect([409, 503]).toContain(rewind.status);
		const bad = await fetch(`${base}/api/sessions/${id}/rewind`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({}) });
		expect(bad.status).toBe(400);
	});
	it("rejects a deploy when the hook is missing", async () => {
		const res = await fetch(`${base}/api/deploy`, { method: "POST", headers: auth });
		expect(res.status).toBe(500);
	});
	it("authenticates WebSocket via subprotocol and rejects bad ones", async () => {
		const good = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["prime-observer.v1", encodeWsBearer(TOKEN)], { origin: `http://127.0.0.1:${server.port}` });
		const first = await new Promise<string>((resolve, reject) => {
			good.once("message", (d) => resolve(d.toString()));
			good.once("error", reject);
		});
		expect(JSON.parse(first).t).toBe("hello");
		good.send(JSON.stringify({ t: "sub", topics: ["fleet"] }));
		const snap = await new Promise<string>((resolve) => good.once("message", (d) => resolve(d.toString())));
		expect(JSON.parse(snap).t).toBe("fleet.snapshot");
		good.close();

		const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["prime-observer.v1", encodeWsBearer("wrong-token-value-here")], { origin: `http://127.0.0.1:${server.port}` });
		const code = await new Promise<number>((resolve) => {
			bad.on("close", (c) => resolve(c));
			bad.on("error", () => undefined);
			bad.on("open", () => bad.send(JSON.stringify({ t: "sub", topics: ["fleet"] })));
		});
		expect(code).toBe(4401);

		const evil = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["prime-observer.v1", encodeWsBearer(TOKEN)], { origin: "https://evil.example" });
		const failed = await new Promise<boolean>((resolve) => {
			evil.on("error", () => resolve(true));
			evil.on("open", () => resolve(false));
		});
		expect(failed).toBe(true);
	});
});
