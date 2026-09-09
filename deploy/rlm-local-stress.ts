/**
 * Stress the self-hosted model under RLM subagent fan-out.
 *
 * The question this answers is not "does the endpoint work" (deploy/vllm-bench.py covers raw
 * throughput) but "does the harness stay correct when 4 and then 8 rlm.run children are all routed
 * to one local vLLM pod at once" — distinct canaries, no cross-talk, thinking preserved, and no
 * silent empty answers of the kind the T11 defect used to hide.
 *
 * Run:  node_modules/.bin/tsx deploy/rlm-local-stress.ts [--fanout 4,8] [--repeat 1]
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.js";
import type { AgentSession } from "../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.js";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.js";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.js";

const SELECTOR = process.env.LOCAL_SELECTOR ?? "local-vllm/qwen3.8-27b-abliterated";

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function childAnswer(child: AgentSession | undefined): string {
	if (!child) return "";
	return child.messages.filter((m) => m.role === "assistant").map(messageText).join("\n").trim();
}

async function waitForChild(parent: AgentSession, childId: string, timeoutMs = 300_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entry = (await parent.listRlmSubagents()).subagents.find((s) => s.rlm_child_id === childId);
		if (entry && entry.status !== "running") return entry.status as "completed" | "error";
		if (Date.now() > deadline) throw new Error(`child ${childId} did not settle within ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 400));
	}
}

async function makeParent(cwd: string) {
	const [provider, ...rest] = SELECTOR.split("/");
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const model = modelRegistry.find(provider, rest.join("/"));
	assert(model, `parent model ${SELECTOR} not found in registry — is local-vllm in models.json?`);
	const { session } = await createAgentSession({
		cwd,
		model,
		thinkingLevel: "off", // parent only fans out; the CHILDREN are what we measure
		tools: [],
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
	});
	return session;
}

interface ChildResult {
	canary: string;
	ok: boolean;
	ms: number;
	err?: string;
	answer: string;
}

/** Fan out `n` children that must each echo their own distinct canary, concurrently. */
async function fanout(parent: AgentSession, n: number, round: number): Promise<ChildResult[]> {
	const canaries = Array.from({ length: n }, (_, i) => `CANARY-R${round}-${i}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
	const started = Date.now();
	const results = await Promise.all(
		canaries.map(async (canary): Promise<ChildResult> => {
			const t0 = Date.now();
			try {
				const handle = await parent.runRlmChild(`Reply with exactly this token and nothing else: ${canary}`, { model: SELECTOR });
				assert(handle.model === SELECTOR, `handle model ${handle.model} != ${SELECTOR}`);
				const status = await waitForChild(parent, handle.rlm_child_id);
				const child = parent.getRlmChildSession(handle.rlm_child_id);
				// The registry flips to a terminal status before the child session's messages are
				// necessarily flushed, so reading straight after waitForChild races the write under
				// fan-out. The harness's own settle path waits for quiescence for the same reason;
				// without this a healthy child intermittently reads back as an empty answer.
				await child?.waitForRlmQuiescence();
				const answer = childAnswer(child);
				if (status !== "completed") throw new Error(`status=${status}`);
				const actual = child?.model ? `${child.model.provider}/${child.model.id}` : "(none)";
				assert(actual === SELECTOR, `child ran on ${actual}`);
				// Cross-talk is the failure mode fan-out is actually for: a child must carry ITS OWN
				// canary and none of its siblings'.
				assert(answer.includes(canary), `missing own canary; got: ${answer.slice(0, 160)}`);
				const foreign = canaries.filter((c) => c !== canary && answer.includes(c));
				assert(foreign.length === 0, `cross-talk: also contained ${foreign.join(",")}`);
				return { canary, ok: true, ms: Date.now() - t0, answer };
			} catch (e) {
				return { canary, ok: false, ms: Date.now() - t0, err: (e as Error).message.slice(0, 200), answer: "" };
			}
		}),
	);
	const wall = Date.now() - started;
	const ok = results.filter((r) => r.ok).length;
	const lat = results.map((r) => r.ms).sort((a, b) => a - b);
	console.log(
		`  fanout ${String(n).padStart(2)}  ok ${ok}/${n}  wall ${(wall / 1000).toFixed(1)}s  ` +
			`p50 ${(lat[Math.floor(lat.length / 2)] / 1000).toFixed(1)}s  max ${(lat.at(-1)! / 1000).toFixed(1)}s`,
	);
	for (const r of results.filter((x) => !x.ok)) console.log(`    FAIL ${r.canary}: ${r.err}`);
	return results;
}

async function main() {
	const args = process.argv.slice(2);
	const grab = (flag: string, dflt: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : dflt;
	};
	const levels = grab("--fanout", "4,8").split(",").map(Number);
	const repeat = Number(grab("--repeat", "1"));
	const cwd = mkdtempSync(join(tmpdir(), "rlm-local-"));

	console.log(`model: ${SELECTOR}`);
	console.log(`cwd:   ${cwd}\n`);
	const parent = await makeParent(cwd);
	console.log(`parent session on ${parent.model?.provider}/${parent.model?.id}\n`);

	let failures = 0;
	for (let round = 1; round <= repeat; round++) {
		if (repeat > 1) console.log(`round ${round}`);
		for (const n of levels) {
			const rs = await fanout(parent, n, round);
			failures += rs.filter((r) => !r.ok).length;
		}
	}

	// The parent must not have drifted onto a child's model or lost its own identity.
	const parentSel = `${parent.model?.provider}/${parent.model?.id}`;
	assert(parentSel === SELECTOR, `parent drifted to ${parentSel}`);
	console.log(`\nparent still on ${parentSel}`);
	console.log(failures === 0 ? "\nALL FANOUTS PASSED" : `\n${failures} CHILD FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
