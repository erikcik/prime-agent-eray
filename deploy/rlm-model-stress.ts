/**
 * Live stress test: heterogeneous-model RLM subagents.
 *
 * Drives real AgentSessions against the credentials in ~/.prime/agent and spawns
 * `rlm.run(...)` children on explicitly selected models, including across providers
 * with different wire APIs (anthropic oauth vs. openai-completions).
 *
 * Run:  node_modules/.bin/tsx deploy/rlm-model-stress.ts [--only T3,T5] [--repeat 3]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.js";
import type { AgentSession } from "../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.js";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.js";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.js";

// ---------------------------------------------------------------- model matrix
const PARENT = "anthropic/claude-haiku-4-5";
const M_SONNET = "anthropic/claude-sonnet-4-6";
const M_OPUS = "anthropic/claude-opus-5";
const M_NANO = "nano-gpt/abliteration-ai/abliterated-model-large-v2";
const M_PRIME = "prime-inference/deepseek/deepseek-v3.2";

// ---------------------------------------------------------------- tiny reporter
interface Check { id: string; name: string; ok: boolean; detail: string; ms: number }
const checks: Check[] = [];
let currentGroup = "";

async function check(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ id, name, ok: true, detail, ms: Date.now() - started });
    console.log(`  PASS ${id}  ${name}  (${Date.now() - started}ms)  ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ id, name, ok: false, detail, ms: Date.now() - started });
    console.log(`  FAIL ${id}  ${name}  (${Date.now() - started}ms)\n       ${detail}`);
  }
}

function group(title: string): void {
  currentGroup = title;
  console.log(`\n=== ${title} ===`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- helpers
function messageText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function childAnswer(child: AgentSession | undefined): string {
  if (!child) return "";
  const assistants = child.messages.filter((m) => m.role === "assistant");
  return assistants.map(messageText).join("\n").trim();
}

/** Poll the parent's registry until the named child settles. */
async function waitForChild(
  parent: AgentSession,
  childId: string,
  timeoutMs = 180_000,
): Promise<"completed" | "error"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = (await parent.listRlmSubagents()).subagents.find((s) => s.rlm_child_id === childId);
    if (entry && entry.status !== "running") return entry.status as "completed" | "error";
    if (Date.now() > deadline) throw new Error(`child ${childId} did not settle within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

function snapshotFor(parent: AgentSession, childId: string) {
  return parent.getRlmChildSnapshots().find((s) => s.id === childId);
}

/** Spawn a child that must echo a unique canary, and verify model + answer. */
async function runCanaryChild(
  parent: AgentSession,
  canary: string,
  kwargs: Record<string, unknown>,
  expectedSelector: string,
): Promise<{ ms: number; answer: string }> {
  const started = Date.now();
  const handle = await parent.runRlmChild(
    `Reply with exactly this token and nothing else: ${canary}`,
    kwargs,
  );
  assert(
    handle.model === expectedSelector,
    `spawn handle model ${handle.model} != requested ${expectedSelector}`,
  );
  const status = await waitForChild(parent, handle.rlm_child_id);
  assert(status === "completed", `child status ${status}`);

  const child = parent.getRlmChildSession(handle.rlm_child_id);
  const actual = child?.model ? `${child.model.provider}/${child.model.id}` : "(none)";
  assert(actual === expectedSelector, `child session ran on ${actual}, expected ${expectedSelector}`);

  const snap = snapshotFor(parent, handle.rlm_child_id);
  assert(snap?.model === expectedSelector, `snapshot model ${snap?.model} != ${expectedSelector}`);

  const answer = childAnswer(child);
  assert(answer.includes(canary), `child did not echo ${canary}; got: ${answer.slice(0, 200)}`);
  return { ms: Date.now() - started, answer };
}

// ---------------------------------------------------------------- session setup
async function makeParent(opts: { selector: string; persist?: boolean; cwd: string }) {
  const [provider, ...rest] = opts.selector.split("/");
  const modelId = rest.join("/");
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(provider, modelId);
  assert(model, `parent model ${opts.selector} not found in registry`);
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    thinkingLevel: "off",
    tools: [],                      // no kernel boot: this exercises model routing, not the REPL
    authStorage,
    modelRegistry,
    ...(opts.persist ? {} : { sessionManager: SessionManager.inMemory() }),
  });
  return session;
}

// ---------------------------------------------------------------- main
async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.indexOf("--only");
  const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(",")) : undefined;
  const repeatArg = args.indexOf("--repeat");
  const repeat = repeatArg >= 0 ? Number(args[repeatArg + 1]) : 3;
  const want = (id: string) => !only || only.has(id);

  const cwd = mkdtempSync(join(tmpdir(), "rlm-stress-"));
  const startedAll = Date.now();
  console.log(`prime-agent RLM heterogeneous-model stress test`);
  console.log(`cwd=${cwd}  parent=${PARENT}  repeat=${repeat}`);

  const parent = await makeParent({ selector: PARENT, cwd });
  const sessions: AgentSession[] = [parent];

  try {
    // ---- T1 discovery -------------------------------------------------
    group("T1 model discovery (rlm.find_models)");
    if (want("T1")) {
      await check("T1.1", "finds an authenticated anthropic model by fuzzy query", async () => {
        const { models } = await parent.findRlmModels("sonnet 4 6", 8);
        const hit = models.find((m) => m.selector === M_SONNET);
        assert(hit, `no ${M_SONNET} in: ${models.map((m) => m.selector).join(", ")}`);
        return `${hit.selector} (${models.length} results)`;
      });
      await check("T1.2", "finds the cross-provider nano-gpt model", async () => {
        const { models } = await parent.findRlmModels("abliterated", 8);
        const hit = models.find((m) => m.selector === M_NANO);
        assert(hit, `no ${M_NANO} in: ${models.map((m) => m.selector).join(", ")}`);
        return hit.selector;
      });
      await check("T1.3", "every discovered model passes an auth preflight", async () => {
        const { models } = await parent.findRlmModels("", 20);
        assert(models.length > 0, "discovery returned nothing");
        const registry = parent.modelRegistry;
        const providers = new Set(models.map((m) => m.provider));
        for (const p of providers) {
          const sample = registry.getAvailable().find((m) => m.provider === p);
          assert(sample, `discovered provider ${p} has no registry model`);
          const auth = await registry.getApiKeyAndHeaders(sample);
          assert(auth.ok, `discovered provider ${p} fails auth preflight`);
        }
        return `providers=${[...providers].join(",")}`;
      });
      await check("T1.5", "an unavailable provider is absent from discovery", async () => {
        const { models } = await parent.findRlmModels("gpt", 20);
        const leaked = models.filter((m) => m.provider === "openai" || m.provider === "openai-codex");
        assert(leaked.length === 0, `unconfigured openai leaked: ${leaked.map((m) => m.selector).join(", ")}`);
        return `no openai models offered (${models.length} results for "gpt")`;
      });
      await check("T1.4", "rejects an out-of-range limit", async () => {
        let threw = "";
        try { await parent.findRlmModels("x", 21); } catch (e) { threw = (e as Error).message; }
        // findRlmModels itself is unbounded; the bound lives in the kernel host handler.
        const handlers = (parent as any)._createKernelHostHandlers();
        try { await handlers["rlm.find_models"]({ query: "x", limit: 21 }); }
        catch (e) { threw = (e as Error).message; }
        assert(/integer from 1 to 20/.test(threw), `unexpected error: ${threw || "(none)"}`);
        return threw;
      });
    }

    // ---- T2 inheritance ------------------------------------------------
    group("T2 default inheritance");
    if (want("T2")) {
      await check("T2.1", "child with no model kwarg inherits the parent model", async () => {
        const r = await runCanaryChild(parent, "CANARY-INHERIT", {}, PARENT);
        return `${PARENT} in ${r.ms}ms`;
      });
    }

    // ---- T3 same-provider switch ---------------------------------------
    group("T3 explicit model, same provider");
    if (want("T3")) {
      await check("T3.1", "haiku parent spawns a sonnet child", async () => {
        const r = await runCanaryChild(parent, "CANARY-SONNET", { model: M_SONNET }, M_SONNET);
        return `${M_SONNET} in ${r.ms}ms`;
      });
      await check("T3.2", "haiku parent spawns an opus child", async () => {
        const r = await runCanaryChild(parent, "CANARY-OPUS", { model: M_OPUS }, M_OPUS);
        return `${M_OPUS} in ${r.ms}ms`;
      });
      await check("T3.3", "parent model is unchanged after the switches", async () => {
        const actual = `${parent.model?.provider}/${parent.model?.id}`;
        assert(actual === PARENT, `parent drifted to ${actual}`);
        return actual;
      });
    }

    // ---- T4 cross-provider ----------------------------------------------
    group("T4 explicit model, across providers / wire APIs");
    if (want("T4")) {
      await check("T4.1", "anthropic-oauth parent spawns an openai-completions child", async () => {
        const r = await runCanaryChild(parent, "CANARY-NANO", { model: M_NANO }, M_NANO);
        return `${M_NANO} in ${r.ms}ms`;
      });
      await check("T4.2", "a third-provider child either works or fails in isolation", async () => {
        const handle = await parent.runRlmChild("Reply with exactly: CANARY-PRIME", { model: M_PRIME });
        assert(handle.model === M_PRIME, `handle model ${handle.model}`);
        const status = await waitForChild(parent, handle.rlm_child_id);
        const child = parent.getRlmChildSession(handle.rlm_child_id);
        const actual = child?.model ? `${child.model.provider}/${child.model.id}` : "(none)";
        assert(actual === M_PRIME, `child ran on ${actual}`);
        const answer = childAnswer(child);
        const outcome =
          status !== "completed"
            ? `errored (${snapshotFor(parent, handle.rlm_child_id)?.error ?? "no detail"})`
            : answer.includes("CANARY-PRIME")
              ? "completed on-script"
              : `completed off-script (said: ${JSON.stringify(answer.slice(0, 60))})`;
        // The point of the check: whatever the third provider did, the parent survives it.
        assert(`${parent.model?.provider}/${parent.model?.id}` === PARENT, "parent model drifted");
        const after = await runCanaryChild(parent, "CANARY-AFTER-PRIME", { model: M_SONNET }, M_SONNET);
        assert(after.answer.includes("CANARY-AFTER-PRIME"), "parent could not spawn after the third provider");
        return `${M_PRIME} ${outcome}; parent healthy, next spawn ok`;
      });
    }

    // ---- T5 heterogeneous fan-out ---------------------------------------
    group("T5 concurrent heterogeneous fan-out");
    if (want("T5")) {
      await check("T5.1", "4 concurrent children on 4 distinct models stay isolated", async () => {
        const plan = [
          { canary: "FANOUT-A", selector: PARENT },
          { canary: "FANOUT-B", selector: M_SONNET },
          { canary: "FANOUT-C", selector: M_OPUS },
          { canary: "FANOUT-D", selector: M_NANO },
        ];
        const started = Date.now();
        const results = await Promise.all(
          plan.map((p) => runCanaryChild(parent, p.canary, { model: p.selector }, p.selector)),
        );
        // cross-talk check: no child may echo another child's canary
        for (let i = 0; i < plan.length; i++) {
          for (let j = 0; j < plan.length; j++) {
            if (i === j) continue;
            assert(
              !results[i].answer.includes(plan[j].canary),
              `child ${plan[i].selector} leaked ${plan[j].canary}`,
            );
          }
        }
        return `4/4 correct models, no cross-talk, wall=${Date.now() - started}ms`;
      });
    }

    // ---- T6 nesting -------------------------------------------------------
    group("T6 depth-2 nesting on a third model");
    if (want("T6")) {
      await check("T6.1", "a sonnet child spawns a nano-gpt grandchild", async () => {
        const handle = await parent.runRlmChild("Stand by.", { model: M_SONNET, name: "stress-mid" });
        await waitForChild(parent, handle.rlm_child_id);
        const mid = parent.getRlmChildSession(handle.rlm_child_id);
        assert(mid, "mid-level child session missing");
        assert(`${mid.model?.provider}/${mid.model?.id}` === M_SONNET, "mid child on wrong model");

        const g = await runCanaryChild(mid, "CANARY-GRANDCHILD", { model: M_NANO }, M_NANO);
        const gs = (await mid.listRlmSubagents()).subagents;
        assert(gs.length === 1, `expected 1 grandchild, got ${gs.length}`);
        return `parent=${PARENT} -> child=${M_SONNET} -> grandchild=${M_NANO} in ${g.ms}ms`;
      });
    }

    // ---- T7 negatives -----------------------------------------------------
    group("T7 rejection paths (must fail closed, no orphan child)");
    if (want("T7")) {
      const before = (await parent.listRlmSubagents()).subagents.length;
      const mustReject = async (label: string, kwargs: Record<string, unknown>, pattern: RegExp) => {
        await check(`T7.${label}`, `rejects ${label}`, async () => {
          let msg = "";
          try { await parent.runRlmChild("should not run", kwargs); }
          catch (e) { msg = (e as Error).message; }
          assert(msg, "spawn unexpectedly succeeded");
          assert(pattern.test(msg), `unexpected error: ${msg}`);
          return msg.slice(0, 110);
        });
      };
      await mustReject("a non-string model", { model: 42 }, /model must be a string/);
      await mustReject("an empty model", { model: "   " }, /must not be empty/);
      await mustReject("an unknown model id", { model: "anthropic/claude-does-not-exist" }, /unavailable, unauthenticated, or expired/);
      await mustReject("an unconfigured provider", { model: "openai/gpt-5.2" }, /unavailable, unauthenticated, or expired/);
      await mustReject("a bare id with no provider", { model: "claude-sonnet-4-6" }, /unavailable, unauthenticated, or expired/);
      await mustReject("an unsupported kwarg", { modle: M_SONNET }, /Unsupported rlm.run kwargs/);
      await check("T7.orphan", "no orphan children were registered by the rejections", async () => {
        const after = (await parent.listRlmSubagents()).subagents.length;
        assert(after === before, `registry grew from ${before} to ${after}`);
        return `registry stable at ${after}`;
      });
    }

    // ---- T8 thinking override ---------------------------------------------
    group("T8 thinking level against a switched model");
    if (want("T8")) {
      await check("T8.1", "explicit thinking level applies to the child model", async () => {
        const handle = await parent.runRlmChild("Reply with exactly: THINK-OK", {
          model: M_SONNET, thinking: "low",
        });
        await waitForChild(parent, handle.rlm_child_id);
        const child = parent.getRlmChildSession(handle.rlm_child_id);
        assert(child?.thinkingLevel === "low", `child thinking=${child?.thinkingLevel}`);
        assert(parent.thinkingLevel === "off", `parent thinking drifted to ${parent.thinkingLevel}`);
        return `child=low parent=off`;
      });
    }

    // ---- T9 persistence ----------------------------------------------------
    group("T9 on-disk transcript records the child model");
    if (want("T9")) {
      await check("T9.1", "a persisted child transcript names its own model", async () => {
        const persistCwd = mkdtempSync(join(tmpdir(), "rlm-stress-persist-"));
        const p2 = await makeParent({ selector: PARENT, persist: true, cwd: persistCwd });
        sessions.push(p2);
        const handle = await p2.runRlmChild("Reply with exactly: PERSIST-OK", { model: M_SONNET });
        const status = await waitForChild(p2, handle.rlm_child_id);
        assert(status === "completed", `child status ${status}`);
        assert(handle.session_dir, "no session_dir on the spawn handle");
        const listed = await SessionManager.list(persistCwd, handle.session_dir);
        assert(listed.length > 0, `no persisted session under ${handle.session_dir}`);
        const opened = SessionManager.open(listed[0].path, handle.session_dir);
        const recorded = opened.buildSessionContext().model;
        const selector = `${recorded?.provider}/${recorded?.modelId}`;
        assert(selector === M_SONNET, `transcript recorded ${selector}, expected ${M_SONNET}`);
        rmSync(persistCwd, { recursive: true, force: true });
        return `transcript model=${selector}`;
      });
    }

    // ---- T10 burst ----------------------------------------------------------
    group(`T10 repeat burst (${repeat}x cross-provider round trip)`);
    if (want("T10")) {
      await check("T10.1", `${repeat} sequential cross-provider spawns all resolve correctly`, async () => {
        const times: number[] = [];
        for (let i = 0; i < repeat; i++) {
          const r = await runCanaryChild(parent, `BURST-${i}`, { model: M_NANO }, M_NANO);
          times.push(r.ms);
        }
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        return `${repeat}/${repeat} ok, avg=${avg}ms, times=[${times.join(", ")}]`;
      });
      await check("T10.2", "the parent registry accounts for every spawned child", async () => {
        const subs = (await parent.listRlmSubagents()).subagents;
        const bad = subs.filter((s) => s.status === "error");
        assert(bad.length === 0, `${bad.length} children ended in error`);
        return `${subs.length} children, 0 errors`;
      });
    }
    // ---- T11 provider hard-failure visibility --------------------------------
    group("T11 a provider-level failure on a child must reach the parent");
    if (want("T11")) {
      await check("T11.1", "a child whose provider hard-fails is NOT reported as a clean completion", async () => {
        const handle = await parent.runRlmChild("Reply with exactly: HARDFAIL-PROBE", { model: M_PRIME });
        const status = await waitForChild(parent, handle.rlm_child_id);
        const child = parent.getRlmChildSession(handle.rlm_child_id);
        const assistants = (child?.messages ?? []).filter((m) => m.role === "assistant");
        const errored = assistants.find((m) => (m as any).stopReason === "error");
        if (!errored) return `provider did not hard-fail this run (status=${status}); check skipped`;

        const providerError = String((errored as any).errorMessage ?? "");
        const snap = snapshotFor(parent, handle.rlm_child_id);
        const notices = parent.messages.filter(
          (m: any) => m.customType === "rlm_child_terminal_notice" && m.details?.childId === handle.rlm_child_id,
        );
        const noticeKind = (notices[0] as any)?.details?.kind;
        const parentSeesError =
          status === "error" ||
          snap?.status === "error" ||
          Boolean(snap?.error) ||
          noticeKind === "failed" ||
          notices.some((n: any) => String(n.content).includes("402"));

        assert(
          parentSeesError,
          `child hard-failed with "${providerError.slice(0, 80)}..." but the parent saw ` +
            `registry=${status} snapshot=${snap?.status} snapshotError=${snap?.error ?? "(none)"} ` +
            `notice=${noticeKind ?? "(none)"} - a provider failure is indistinguishable from a silent success`,
        );
        return `provider error surfaced to parent (notice=${noticeKind})`;
      });
    }
  } finally {
    for (const s of sessions) { try { s.dispose(); } catch {} }
    rmSync(cwd, { recursive: true, force: true });
  }

  // ---- summary -------------------------------------------------------------
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  console.log(`\n${"=".repeat(74)}`);
  console.log(`SUMMARY  ${passed}/${checks.length} passed  ${failed ? `${failed} FAILED` : "(all green)"}  wall=${Math.round((Date.now() - startedAll) / 1000)}s`);
  for (const c of checks.filter((c) => !c.ok)) console.log(`  FAILED ${c.id}  ${c.name}\n         ${c.detail}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error("stress harness crashed:", error); process.exit(2); });
