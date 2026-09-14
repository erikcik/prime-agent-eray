import { describe, expect, it } from "vitest";
import type { Arm, BenchRun, Experiment, Trial } from "../src/shared/bench.ts";
import { parseClaudeStream } from "../src/server/bench/cc-transcript.ts";
import { defaultArms, summarizeRun, verifiedSkills } from "../src/server/bench/results.ts";

const arms: Arm[] = [
	{ id: "raw", label: "raw", harness: "prime-agent", variantId: null, model: "anthropic/claude-opus-5", memory: "snapshot", insertion: "system-prompt" },
	{ id: "v1", label: "v1", harness: "prime-agent", variantId: "research-first", model: "anthropic/claude-opus-5", memory: "snapshot", insertion: "system-prompt" },
	{ id: "v2", label: "v2", harness: "prime-agent", variantId: "atomic-plan", model: "anthropic/claude-opus-5", memory: "snapshot", insertion: "system-prompt" },
	{ id: "cc", label: "cc", harness: "claude-code", variantId: "research-first", model: "opus", memory: "none", insertion: "system-prompt" },
];

function trial(armId: string, taskId: string, status: Trial["status"], score?: number, cost = 1): Trial {
	return { id: `${armId}-${taskId}-${Math.random()}`, runId: "r1", taskId, armId, repeat: 0, status, costUsd: cost, durationMs: 1000, warnings: [], verdict: score === undefined ? undefined : { passed: status === "passed", score, summary: "", criteria: [], judgeModel: "opus", at: "t", costUsd: 0.5 } };
}

const run: BenchRun = {
	id: "r1",
	experimentId: "e1",
	trigger: "manual",
	status: "done",
	createdAt: "2026-09-14T00:00:00Z",
	environment: {},
	arms,
	variants: [
		{ id: "research-first", name: "research first", skill: "---\nname: research-first\n---\nx" },
		{ id: "atomic-plan", name: "atomic", skill: "y" },
	],
	taskIds: ["t1", "t2"],
	trials: [
		trial("raw", "t1", "passed", 0.9),
		trial("raw", "t2", "failed", 0.2),
		trial("v1", "t1", "passed", 1),
		trial("v1", "t2", "passed", 0.8),
		trial("v2", "t1", "failed", 0.3),
		trial("v2", "t2", "error"),
		trial("cc", "t1", "passed", 0.7),
		trial("cc", "t2", "running"),
	],
};

describe("run summaries", () => {
	it("computes pass rate, scores, cost and matrix cells; errors count as finished failures", () => {
		const s = summarizeRun(run);
		const raw = s.arms.find((a) => a.armId === "raw")!;
		expect(raw.passRate).toBe(0.5);
		expect(raw.meanScore).toBeCloseTo(0.55);
		expect(raw.costUsd).toBeCloseTo(3);
		const v2 = s.arms.find((a) => a.armId === "v2")!;
		expect(v2.finished).toBe(2);
		expect(v2.passRate).toBe(0);
		const cc = s.arms.find((a) => a.armId === "cc")!;
		expect(cc.finished).toBe(1);
		expect(s.cells.find((c) => c.taskId === "t2" && c.armId === "v1")).toMatchObject({ passed: 1, finished: 1, meanScore: 0.8 });
	});

	it("verifies only variants that beat the matching raw arm by the minimum lift", () => {
		const exp = { id: "e1", title: "research first", variants: run.variants } as Experiment;
		const v = verifiedSkills([exp], [run], new Map([["t1", "Task one"]]), 0.1);
		expect(v.map((x) => x.variant.id)).toEqual(["research-first"]);
		expect(v[0]!.lift).toBe(0.5);
		expect(v[0]!.taskTitles).toEqual(["Task one", "t2"]);
		expect(verifiedSkills([exp], [{ ...run, status: "running" }], new Map(), 0.1)).toEqual([]);
	});

	it("builds default arms with raw baselines for both harnesses", () => {
		const a = defaultArms(["a", "b"], { primeAgent: "anthropic/claude-opus-5", claudeCode: "opus" });
		expect(a.map((x) => x.id)).toEqual(["pa-raw", "cc-raw", "pa-v1", "cc-v1", "pa-v2", "cc-v2"]);
		expect(defaultArms(["a"], { primeAgent: "m", claudeCode: "o" }, false).map((x) => x.harness)).toEqual(["prime-agent", "prime-agent"]);
	});
});

describe("claude code stream parsing", () => {
	it("turns stream-json into rows with cost and tokens", () => {
		const stream = [
			'{"type":"system","subtype":"init","session_id":"abc"}',
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Researching first." }, { type: "tool_use", name: "WebSearch", input: { query: "skool ad courses" } }] } }),
			JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "10 results" }, { type: "image", source: {} }] }] } }),
			JSON.stringify({ type: "result", is_error: false, total_cost_usd: 1.25, result: "done", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }),
		].join("\n");
		const s = parseClaudeStream(stream);
		expect(s.sessionId).toBe("abc");
		expect(s.rows.map((r) => r.role)).toEqual(["assistant", "assistant", "tool"]);
		expect(s.rows[1]!.text).toContain("WebSearch");
		expect(s.rows[2]!.imageCount).toBe(1);
		expect(s.costUsd).toBe(1.25);
		expect(s.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
		expect(s.isError).toBe(false);
	});
});
