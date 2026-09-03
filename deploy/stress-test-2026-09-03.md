# Stress test — 2026-09-03

Three deliverables, each exercised end to end. Nothing under `packages/*` was modified.

## 1. NanoGPT uncensored provider (`abliteration-ai/abliterated-model-large-v2`)

Mac, through the shared daemon (`prime-agent -p …`), all via `~/.prime/agent/models.json` + `auth.json`.

| # | test | result |
|---|---|---|
| 1 | `prime-agent model list nano` + smoke reply | listed (1M ctx / 32K out / thinking yes); "pong" in 8.5 s |
| 2 | ipython tool round trip (write + read file) | file correct on disk; 7.5 s |
| 3 | 10 separate tool calls (10 files) + final JSON | all 10 correct; 47 s |
| 4 | `--mode json` streaming | 39 `text_delta`s; usage `{input 7682, output 349, cacheRead 704}` + cost |
| 5 | RLM child on the nano model (`rlm(..., model="nano-gpt/…")`) | child admitted, completed, wrote its file; `child_usage_attributed` + `rlm-ledger` spawn recorded |
| 6 | 3 concurrent `-p` sessions | 1111 / 2222 / 3333 all correct |
| 7 | ~200k-token attachment, needle at the end | codeword found; 18.6 s |
| 8a | invalid key (`--api-key`) | `401 Invalid session` surfaced immediately |
| 8b | 6-request burst | all correct, no 429 |
| 9 | cost reconciliation vs `GET /api/v1/usage` | exact to the microdollar once cache reads are $0.5/M (input $5, output $5) |
| 10 | `deploy/smoke/json-assert.mjs` (event ordering, tool call, usage) | PASS on Mac, in the container, and on the pod |
| 11 | alternate `--daemon-socket` print run | not supported by print mode's auto-start; use the default socket (noted, not needed) |

**Defect found and fixed:** NanoGPT accepts only `reasoning_effort ∈ {low, high, max}` for this model. The
Mac passed because `settings.json` had `defaultThinkingLevel: high`; a fresh agent dir (container) used the
harness default `medium` and every request 400'd. `thinkingLevelMap` now maps off/minimal→low,
medium→high, xhigh→max; verified `:off`, `:medium`, `:max` in the container.

## 2. Observer web UI

* 26 vitest tests (readers, tree builder, harness merge, auth, env, server smoke with daemon offline + WebSocket auth/origin).
* Live against the Mac daemon: fleet signal (38 saved / 6 subagents), family boards, live ticker, lineage
  (incl. deleted ghosts), session inspector streaming a NanoGPT session with ipython blocks, comms
  (12 agent-to-agent messages), harness history (3 local refinements), installed skills (13 bundled),
  schedules, ops. New-session dialog → agent built a package, spawned a reviewer child, child wrote REVIEW.md.
* **Redeploy button**: hook ran (pull → install → build → restart), observer exited 87, supervisor
  restarted it in ~1 s, page auto-reloaded with the new start time and the persisted deploy log.
* Fixes during testing: session-artifacts path is two levels up (harness formula); hub sub/unsub race
  duplicated ticker events; refresh hook diffed against an origin that was *behind* (now ancestor-checked);
  the harness build regenerates `packages/ai/src/models.generated.ts`, so the hook restores `packages/`
  before pulling.

## 3. Docker + RunPod CPU pod

**Local compose rehearsal** (named volume as `/workspace`): first boot cloned via the deploy key, built
harness + observer, daemon + observer up in ~3 min; `/api/health` public, `/api/fleet` 401 without / 200
with token; `json-assert --tool` PASS through the containerized daemon and the baked kernel venv.

**Pod** `hzymwdbv6iy7nc` (cpu3g-4-16, EU-RO-1, $0.16/h, volume `y0n17rf3mc`, image `ghcr.io/erikcik/prime-agent-eray:0.1.1`):

| test | result |
|---|---|
| first boot on the volume | image pull ≈ 2 min, clone + build ≈ 4 min → `listening` |
| proxy URL `https://hzymwdbv6iy7nc-8790.proxy.runpod.net` | login page renders (Geist via Google Fonts, CSP ok); `/api/fleet` 401/200 by token |
| WebSocket through the RunPod proxy | subprotocol `prime-observer.v1` negotiated, origin accepted, `hello` + `fleet.snapshot` + `daemon.state` in < 0.5 s |
| NanoGPT session on the pod | `pod-demo` built a package, tests passed, spawned `pod-reviewer` (nano) |
| **Refresh while the agent worked** | pulled 1 incoming commit, skipped install/build, observer restarted in 25 s; agent + child kept running |
| mirror `deploy/pod-mirror.sh --once` | `/workspace` (69 MB, excludes node_modules/.git) on the Mac in 19 s over `213.173.105.97:34446` |
| terminate → new pod on same volume | done implicitly: pod 2 reused pod 1's `state/ssh` (identical fingerprint `SHA256:oDZi…`) |
| stop → start | _see below_ |

**Defect found and fixed:** the first pod (`26qbk1ihcmfsmh`) crash-looped: the deploy key written to
`/workspace/state/deploy_key` read back as 0666 (RunPod volumes ignore chmod) and ssh refused it. The key
now lives on container disk (`~/.ssh/deploy_key`); image 0.1.1.

**Provisioning:** neither the `runpod` MCP `create-pod` nor `runpodctl pod create` can size a CPU pod (and
the MCP cannot attach a network volume) — both produce a 2-vCPU pod and reject a 40 GB container disk.
`deploy/runpod-deploy.py` uses the GraphQL `deployCpuPod` mutation with `instanceId: cpu3g-4-16`.

## Open items

* `ANTHROPIC_OAUTH_TOKEN` is not set on the pod yet: Eray must run `claude setup-token` and add the
  resulting `sk-ant-oat01-…` token to the template env (then recreate the pod, or edit env via `podEditJob`).
* `deploy/**` changes (entrypoint/refresh) need a pod restart to take effect; the hook says so.
* A `packages/**` change restarts the daemon (interrupting in-flight turns); the hook refuses while agents
  are working unless `REFRESH_FORCE=1`.
