import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BenchTask, VerifiedSkill } from "../src/shared/bench.ts";
import { SessionActivity } from "../src/server/bench/activity.ts";
import { advisorMessage } from "../src/server/bench/advisor.ts";
import { looksLikeIntervention } from "../src/server/bench/intervention.ts";
import { mergeHarnessRaw, modelArgs, normalizeVerdict, skillBlock, trialAuth } from "../src/server/bench/runner.ts";
import { ensureFrontmatter, normalizeCriteria } from "../src/server/bench/service.ts";

const root = mkdtempSync(join(tmpdir(), "bench-activity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe("session activity tail reader", () => {
	it("skips history on first sight, reports appended user messages once, waits for complete lines, persists offsets", () => {
		const sessions = join(root, "sessions");
		mkdirSync(join(sessions, "nested"), { recursive: true });
		const file = join(sessions, "s1.jsonl");
		writeFileSync(file, line({ type: "session", id: "s1", cwd: "/work" }) + line({ type: "message", id: "u0", parentId: null, timestamp: "t", message: { role: "user", content: "old" } }));
		const state = join(root, "activity.json");
		const act = new SessionActivity(sessions, state);

		const old = new Date("2026-01-01T00:00:00Z");
		utimesSync(file, old, old);
		expect(act.scan([file]).users).toEqual([]);
		expect(act.knownFiles()[0]!.lastActivityAt).toBe(old.toISOString());

		appendFileSync(file, line({ type: "message", id: "a1", parentId: "u0", timestamp: "t", message: { role: "assistant", content: [] } }));
		appendFileSync(file, line({ type: "message", id: "u1", parentId: "a1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "benchmark this" }] } }));
		appendFileSync(file, '{"type":"message","id":"u2","parentId":"u1","timestamp":"t","message":{"role":"user","content":"par');
		const r1 = act.scan([file, file]);
		expect(r1.users.map((u) => [u.entry.id, u.text, u.cwd, u.sessionId])).toEqual([["u1", "benchmark this", "/work", "s1"]]);
		expect(r1.touches[0]!.appended).toBe(2);

		appendFileSync(file, 'tial"}}\n');
		act.flush();
		const reloaded = new SessionActivity(sessions, state);
		expect(reloaded.scan([file]).users.map((u) => u.text)).toEqual(["partial"]);
		expect(reloaded.scan([file]).users).toEqual([]);

		const nested = join(sessions, "nested", "child.jsonl");
		writeFileSync(nested, line({ type: "session", id: "c" }));
		expect(reloaded.isRootSessionFile(nested)).toBe(false);
	});
});

describe("runner and advisor helpers", () => {
	const task = {
		finalState: [
			{ id: "c1", text: "researched sources", required: true },
			{ id: "c2", text: "nice to have", required: false },
		],
	} as BenchTask;

	it("enforces required criteria over the judge's own verdict and clamps the score", () => {
		const v = normalizeVerdict(task, { passed: true, score: 7, summary: "ok", criteria: [{ id: "c2", met: true, evidence: "x" }] }, "opus");
		expect(v.passed).toBe(false);
		expect(v.score).toBe(1);
		expect(v.criteria.find((c) => c.id === "c1")).toMatchObject({ met: false, evidence: "not assessed by the judge" });
		const ok = normalizeVerdict(task, { passed: true, score: 0.8, summary: "", criteria: [{ id: "c1", met: true, evidence: "file a.md" }] }, "opus");
		expect(ok.passed).toBe(true);
	});

	it("merges local memory over global", () => {
		const m = mergeHarnessRaw({ schema: 1, entries: { memory: { a: { v: 1 }, b: { v: 1 } } }, refinements: [1] }, { schema: 2, entries: { memory: { b: { v: 2 } }, prompt: { p: {} } }, refinements: [2] });
		expect(m).toEqual({ schema: 2, entries: { memory: { a: { v: 1 }, b: { v: 2 } }, prompt: { p: {} } }, refinements: [1, 2] });
		expect(mergeHarnessRaw(undefined, undefined)).toBeUndefined();
	});

	it("never copies rotating OAuth credentials into a trial", () => {
		const r = trialAuth({
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			legacy: { access: "a", refresh: "r" },
			"nano-gpt": { type: "api_key", key: "k" },
		});
		expect(r.dropped.sort()).toEqual(["anthropic", "legacy"]);
		expect(r.kept).toEqual({ "nano-gpt": { type: "api_key", key: "k" } });
		expect(trialAuth(undefined)).toEqual({ kept: {}, dropped: [] });
	});

	it("splits provider/model", () => {
		expect(modelArgs("anthropic/claude-opus-5")).toEqual(["--provider", "anthropic", "--model", "claude-opus-5"]);
		expect(modelArgs("claude-sonnet-4-6")).toEqual(["--model", "claude-sonnet-4-6"]);
	});

	it("recognises benchmark requests loosely; the helper makes the final call", () => {
		expect(looksLikeIntervention("you should have researched first. Benchmark this")).toBe(true);
		expect(looksLikeIntervention("make a bench mark out of it")).toBe(true);
		expect(looksLikeIntervention("deploy the site")).toBe(false);
		const injected = advisorMessage("writing store copy", [{ variant: { id: "v", name: "v", skill: "x" } } as VerifiedSkill]);
		expect(injected).toMatch(/benchmark/i);
		expect(looksLikeIntervention(injected)).toBe(false);
	});

	it("inserts skill text verbatim in advisor messages and installed skills", () => {
		const variant = { id: "research-first", name: "Research first", skill: "Look at Skool, Whop and YouTube before deciding." };
		expect(skillBlock(variant)).toContain(variant.skill);
		const msg = advisorMessage("choosing ad music", [{ variant } as VerifiedSkill]);
		expect(msg).toContain("You are about to attempt a major step: choosing ad music");
		expect(msg).toContain(variant.skill);
		expect(ensureFrontmatter(variant)).toMatch(/^---\nname: research-first\ndescription: Research first\n---/);
		expect(ensureFrontmatter({ ...variant, skill: "---\nname: x\n---\nbody" })).toBe("---\nname: x\n---\nbody\n");
	});

	it("normalizes criteria ids and drops empty ones", () => {
		expect(normalizeCriteria([{ text: " a " }, { id: "c1", text: "b", required: true }, { text: "" }])).toEqual([
			{ id: "c1", text: "a", required: false },
			{ id: "c1x", text: "b", required: true },
		]);
	});
});
