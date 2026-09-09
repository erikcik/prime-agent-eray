# Stress test — self-hosted Qwen3.8-27B abliterated, deployed from the observer (2026-09-09)

**Question:** can a GPU pod running a local model replace the per-token NanoGPT provider for RLM
subagent fan-out, deployed from one button in the web UI, at a token rate comparable to the hosted
harnesses?

**Answer:** yes. Five defects were found by driving the real UI; all five are fixed. One model-quality
caveat stands, below.

Deployed **through the observer's "Deploy model" button**, not the CLI: pod `1l2gup14pjfpq0`,
RTX PRO 6000 Blackwell Server Edition (96 GB), EU-RO-1, `$2.09/hr`, mounting the existing volume
`o6kytzktj0`. Config rationale in `deploy/README-vllm.md`.

## The integration, verified end to end

Click **Deploy model** → confirm dialog states datacenter, volume, download size and hourly cost →
`POST /api/model-pod/deploy` → `deploy/vllm-pod.py` walks the GPU ladder → RunPod places the pod →
the card tracks `absent → downloading → ready` (285 s) → **the service rewrites
`models.json` `local-vllm.baseUrl` to the new pod URL automatically**. No manual step in the chain.

## Throughput — `deploy/vllm-bench.py`

| concurrency | per stream | aggregate | TTFT p50 |
|---|---|---|---|
| 1 | 73.2 tok/s | 73.1 tok/s | 0.42 s |
| 4 | 61.9 tok/s | 197.0 tok/s | 2.26 s |
| 8 | 62.2 tok/s | 307.1 tok/s | 3.79 s |
| 16 | 47.5 tok/s | **684.9 tok/s** | 3.65 s |

An earlier pod on the *Workstation* edition of the same card measured 83.4 tok/s single-stream, so
treat **73–83 tok/s** as the band rather than quoting the best run. 16 is the configured
`--max-num-seqs` ceiling; it degrades gracefully, so there is real headroom above 8 subagents.

## RLM subagent fan-out — `deploy/rlm-local-stress.ts --fanout 4,8 --repeat 3`

**24/24 children passed.** Correct model routing every time, every child carried its own canary and
none of its siblings', parent never drifted. 8 children settle in 3.1–6.3 s.

## Tool calling and soak

* **18/18 tool calls correct** at 8-way concurrency — right function name, correctly-typed integer
  argument, via `--tool-call-parser qwen3_coder`.
* **Soak: 48/48 requests over 6 waves of 8 concurrent**, aggregate 520–577 tok/s with no downward
  trend. No preemption, no failures.

## Thinking

Always on, `reasoning_effort: xhigh`, no toggle by construction. Reasoning lands in the separate
`reasoning` field, `<think>` never leaks into `content`, `reasoning_tokens` accounted separately,
short turns finish on `stop` not `length`.

## Five defects found by clicking the real UI

None of these were visible from unit tests or the CLI.

1. **502 status made a pod failure look like an observer outage.** `api.ts` maps 502/503/504 to
   "Observer unreachable — it may be restarting", so a RunPod capacity refusal claimed the observer
   had died. Now 409 with a `model_pod_deploy_failed` code.
2. **GraphQL errors exited 0, so failures were invisible.** GraphQL answers HTTP 200 with an
   `errors` array; `vllm-pod.py` printed it and exited 0. `ModelPodService` checks the exit code, so
   a resume RunPod flatly refused was recorded as success and the card sat on `stopped` for 20
   minutes saying nothing. Now exits non-zero with the real message.
3. **Stop-and-resume is the wrong lifecycle for a scarce GPU.** A *stopped* pod stays pinned to its
   original host machine. RunPod refused the resume — *"there are not enough free GPUs on the host
   machine to start this pod"* — and meanwhile the Workstation edition left EU-RO-1 entirely, so
   that pod could never have restarted. **Stop now terminates.** It costs nothing: the 19.5 GB of
   weights live on the network volume, so a fresh deploy is equally warm and can land on any host
   with capacity. (Matches the "stopping a pod can strand it" note from the 2026-08-31 work.)
4. **Dead pod ids were never cleared.** A pod terminated out-of-band left the card reporting
   `starting` forever. Now detects the null pod and self-heals to `absent`.
5. **The status poll was a request storm.** `pod` sat in the dependency array of an effect that also
   called `setPod`, so every response re-ran the effect and fired the next request immediately.
   Besides hammering the observer and RunPod, it left the card rendering a stale phase, which greyed
   out "Deploy model" so a click did nothing. Rewritten as a self-scheduling timeout reading the
   phase from a ref.

Also fixed earlier, from the CLI round: **the RunPod proxy 403s `urllib`'s default User-Agent** —
looks exactly like an auth failure but never reaches vLLM.

## The one real model-quality caveat

Twenty samples each, direct to the endpoint:

| probe | result |
|---|---|
| reproduce an exact token, nothing else | **20/20** |
| answer a question **and** open with an exact literal marker | **0/20** |

Every sampled failure of the second probe **answered correctly** and wrote `TASK:` instead of
`TASK-7:`. So this is not task competence — the model deprioritises literal formatting constraints
once it also has substantive content to produce. Structured output via tool calling is unaffected
(18/18), so prefer tool calls over literal tags when routing work here. This is a genuine gap versus
GLM-5.3.

## Standing operational risk

**EU-RO-1 capacity for the only GPU family the volume can reach swings between LOW and empty within
minutes.** Observed across one session: all four ladder candidates refused, a stopped pod stranded,
the Workstation edition leaving the datacenter, then Server Edition recovering. The volume cannot
leave EU-RO-1, so "Deploy model" will sometimes need a retry. The ladder plus honest error reporting
is the mitigation; a second volume in a steadier datacenter is the alternative if it becomes a daily
annoyance.

## Not covered

* The observer was driven **locally** against the real RunPod API, not from the prime-agent pod —
  the pod pulls from git and the changes are uncommitted.
* Soak was ~25 s of continuous load, not hours.
* Concurrency above the configured 16 is untested by design.
