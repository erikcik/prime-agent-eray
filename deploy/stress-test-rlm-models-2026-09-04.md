# Stress test — heterogeneous-model RLM subagents (2026-09-04)

**Question:** can the harness run `rlm(...)` subagents on models *other than* the parent's?
**Answer:** yes — it is a first-class, fully plumbed feature. 24/25 live checks passed on the
first run; the one failure (T11) was a real defect, now **fixed** — 25/25 after the patch.

Harness: `deploy/rlm-model-stress.ts` (`node_modules/.bin/tsx deploy/rlm-model-stress.ts [--only T3,T5] [--repeat N]`).
It drives real `AgentSession`s against the credentials in `~/.prime/agent` and calls
`session.runRlmChild(...)` — the exact function the kernel's `rlm.run` host handler calls.

## The capability, as it actually exists

`rlm.run(prompt, model=..., thinking=..., name=...)` from the Python REPL:

- `model` takes an exact `provider/id` selector. Omit it and the child inherits the parent's model.
- `await rlm.find_models(query, limit)` searches the *authenticated* catalog (fuzzy, limit 1–20).
  It is deliberately kept out of the system prompt so the catalog does not burn context.
- Resolution (`agent-session.ts:_resolveRlmSubagentModel`) requires the model to be in
  `getExecutableModels()` **and** to pass a live `getApiKeyAndHeaders` preflight. An unavailable,
  unauthenticated or expired model fails the spawn — there is no silent fallback to the parent model.
- `thinking` overrides the inherited level; a level the resolved child model does not support
  fails the spawn.
- Upstream unit coverage: `packages/coding-agent/test/suite/regressions/4649-subagent-model-selection.test.ts`
  (16 tests, faux provider) — re-run on this checkout, 16/16 pass.

Authenticated providers on this Mac: `anthropic` (subscription OAuth), `nano-gpt` (api key),
`prime-inference` (Prime CLI key — **is** authenticated, but the balance is empty so it 402s).

## Results — 24/25 pass, wall 115s

| # | Check | Result |
|---|---|---|
| T1.1–1.5 | discovery: fuzzy match, cross-provider match, every hit passes an auth preflight, unconfigured `openai` absent, limit>20 rejected | PASS |
| T2.1 | no `model` kwarg → child inherits `anthropic/claude-haiku-4-5` | PASS |
| T3.1–3.2 | haiku parent → sonnet child; haiku parent → opus child | PASS |
| T3.3 | parent model does not drift after the switches | PASS |
| T4.1 | **cross-wire-API**: anthropic-oauth parent → openai-completions (`nano-gpt`) child | PASS |
| T4.2 | third provider (`prime-inference`) fails in isolation; parent healthy, next spawn fine | PASS |
| T5.1 | **4 concurrent children on 4 distinct models**, all correct, zero canary cross-talk (8.5s) | PASS |
| T6.1 | **depth-2**: haiku → sonnet child → nano-gpt grandchild | PASS |
| T7.× | rejects non-string / empty / unknown id / unconfigured provider / bare id / typo'd kwarg; registry unchanged (no orphans) | PASS |
| T8.1 | `thinking="low"` applies to the child model; parent stays `off` | PASS |
| T9.1 | persisted child transcript on disk records **the child's own model**, not the parent's | PASS |
| T10.1–10.2 | 3 sequential cross-provider round trips, 15 children total, 0 errors | PASS |
| T11.1 | a child whose provider hard-fails must not look like a clean completion | **FAIL → PASS after fix** |

Also verified through the **real user-facing path** (not the SDK shortcut): a `prime-agent -p` run
executing `await rlm.run('...', model='nano-gpt/abliteration-ai/abliterated-model-large-v2')` inside
the live ipython kernel spawned a real cross-provider child that replied `KERNEL-CANARY`.

Latency note: nano-gpt round trips are usually 1.6–4.5s but one burst iteration took 47s.
Provider-side variance, not a harness fault — but it argues for a timeout when fanning out to it.

## The defect (T11) — found, then fixed

A child routed to `prime-inference/deepseek/deepseek-v3.2` gets a real
`402 Insufficient balance` from the provider. Its final assistant message is
`stopReason: "error"` with that `errorMessage`. **Before the fix** the parent saw:

- `listRlmSubagents()` status → `completed`
- child snapshot → `status: "done"`, `error: undefined`, `tokenCount: 0`
- the only terminal notice → `"RLM child … completed without sending a reply"`

So **"the provider rejected every request" was indistinguishable from "the child ran fine and
chose not to reply."** The 402 text appeared nowhere in the parent's view.

Cause — `agent-session.ts`, the child event subscription (~L10565): the `message_end` handler
special-cases `stopReason === "error"` to skip usage attribution, but never records the error, so
the run reached `if (run.error) throw ...` with `run.error` unset and fell through to
`run.status = "done"`.

**Why it matters more with multi-model subagents:** with every child on the parent's model, a
credential/billing failure takes down the whole session and is obvious. The moment children are
routed to *different* providers, each child carries its own billing, auth and rate-limit surface —
and this path turned any of those failures into a silent empty answer.

### The fix (applied)

`packages/coding-agent/src/core/agent-session.ts`, in the RLM child settle path. The check goes
*after* the run settles, not inside `message_end`: the session retries transient provider errors,
so an intermediate errored `message_end` is not terminal — only the final message is.

```ts
await child.waitForRlmQuiescence();
if (run.error) throw new Error(run.error);
// A child whose provider rejected the run settles quiescent with no reply, which is
// otherwise indistinguishable from a child that simply had nothing to say. Only the
// final message is terminal here: transient provider errors are retried internally,
// so an intermediate errored message_end must not fail the run.
const lastChildAssistant = child._findLastAssistantMessage();
if (lastChildAssistant?.stopReason === "error" && lastChildAssistant.errorMessage) {
    throw new Error(lastChildAssistant.errorMessage);
}
run.status = "done";
```

The throw routes into the pre-existing `createRlmChildFailureMessage` path. Verified after:

```
registry status: error
snapshot status: error | snapshot error: 402 Insufficient balance (including overdraft)...
parent message: [rlm_child_failure] RLM child subagent-... failed: 402 Insufficient balance ...
```

**Verification after the patch:** `tsc --noEmit` clean. Every test file that touches
`runRlmChild` / RLM child lifecycle re-run — 13 files, **252 tests, all pass**, including the 16
upstream `4649-subagent-model-selection` tests and `rlm-ledger`, `agent-session-recursion`,
`3885-subagent-runtime-host`, `617-subagent-terminal-agent-message`, `acp-rlm-subagents`.
T11 in the stress harness is the standing regression test.

*Caveat on the wider suite:* a full `test/suite/` run was not completed cleanly. Runs of it showed
1–3 failures in `4606-update-restart-coordinator`, `4685-daemon-client-modes` and
`4600-supervisor-singleton` — but a *different* test failed each time, those three files pass
39/39 when run serially, and none of them touch the RLM path. They look like pre-existing
order/timing flakiness in the daemon and cwd-mutating tests (one run also logged a vitest worker
crash, which vitest itself warns can cause false positives). Not attributed to this patch, but a
clean full-suite baseline was never established either way.

**Note:** this is the only edit to `packages/*` in this clone, so a future `git pull` from
`upstream` may need a small merge here. Worth filing upstream to retire the local diff.
