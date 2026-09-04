# Stress test 2026-09-04 — "stop it tonight, redeploy tomorrow, is everything the same?"

Question: if the pod is removed so it stops consuming credits and is later redeployed against the
same network volume, is the state identical — session showcase, transcripts, the Mac mirror, new
session creation, web search, Claude auth?

**Answer: yes for state, with four operational caveats (below).** Verified by snapshot/compare with
`deploy/verify-pod.py`, not by inspection.

Volume under test: `o6kytzktj0`. Harness 0.9.1, observer 0.1.0, image `0.1.2` throughout.

## Two paths, and they are not equivalent

| | stop → start | terminate → redeploy |
|---|---|---|
| recovery time | **19 s** | **82 s** |
| pod id / **web UI URL** | **unchanged** | **CHANGES** — new id, new URL, new bookmark |
| machine | same | different host |
| ssh host:port | ip same, **port remaps** | **both change** |
| compute billing while down | stopped | stopped |
| pod still listed in RunPod | yes | no (zero pods) |
| container disk | kept | discarded (irrelevant — all state is on the volume) |

The network volume bills either way (50 GB ≈ $3.50/mo). That is the floor: there is no way to keep
the state and pay nothing.

## Results

`deploy/verify-pod.py compare` — **ALL CHECKS PASSED** across terminate → redeploy:

* auth still enforced (401 no token / 401 bad token / 200 good token); daemon `online`
* all 4 prior sessions still listed, every transcript still served (HTTP 200)
* **on-disk `message` record counts identical** per session (2 / 108 / 8 / 10)
* per-session cost and model unchanged (incl. the $6.05 claude-fable-5 ad session)
* `settings.json` unchanged (`anthropic/claude-opus-5`) — the first-boot seed correctly did **not**
  re-run; git checkout unchanged; agent dir contents unchanged
* the three ad mp4s **byte-identical by md5**
* `SERPER_API_KEY` and `ANTHROPIC_OAUTH_TOKEN` present in the daemon env
* live end-to-end session on the redeployed pod: `DEEP_OK 42 Prime Intellect — The Open
  Superintelligence Stack` (ipython kernel + Serper web search + Claude over subscription OAuth)
* **conversational continuity**: session `01a068e8`, created on pod `dcmhshd4c18p5k` (terminated two
  pods earlier), was resumed and correctly recalled its own earlier reply `pod-claude-ok`
* mirror reconnected on the new port and pulled the new sessions into `~/Desktop/prime-agent-pod2`

## Caveats — the four things that are NOT automatic

1. **The web UI URL changes on terminate → redeploy** (it is `https://<POD_ID>-8790.proxy.runpod.net`).
   Stop → start keeps it. If you want a stable bookmark overnight, prefer stop → start.
2. **The mirror must be restarted with the new ssh port** after *any* restart — RunPod remaps the
   public 22/tcp port every time. Stop the mirror before the restart; it does not self-heal.
   The ssh *host key* is on the volume, so it never changes and you get no MITM warning.
3. **Stop the pod when sessions are idle, not mid-task.** In-flight work is not replayed. The harness
   appends a `prime-agent.worker_recovery` record saying "uncertain model, tool, bash, or child-agent
   work was not replayed — inspect external side effects". Saved transcripts are intact either way,
   but a half-finished ffmpeg render or a half-posted API call is on you to check.
4. **Agent session names are unique per volume, forever.** Reusing a name that exists at depth 0
   returns a bare `502 daemon did not return an active session id` from `POST /api/sessions`; the real
   reason is only in the pod log (`Agent name "x" is unavailable`). Stamp names.

## Known-benign difference (do not chase this)

The observer's `messageCount` for a session drops after a restart — the ad session read 111 live and
108 reloaded. **Nothing is lost**: a live in-memory session counts `custom_message` records, a
disk-reloaded one does not. The session file actually *grew* (201 → 202 lines) because the recovery
notice was appended, and `type=="message"` records were 108 before and after. `verify-pod.py`
therefore compares on-disk message records and only prints a NOTE for the API count.

## Tooling gotcha

RunPod's proxy is behind Cloudflare, which 403s (`error code: 1010`) on the default
`Python-urllib` user agent — every request dies pre-auth. `verify-pod.py` sends a browser UA.
Also `/api/health` is deliberately public, so auth checks must probe a protected route
(`/api/sessions`) or they pass vacuously.

## Re-running

```bash
python3 deploy/verify-pod.py snapshot before.json --url <observer> --host <ip> --port <ssh>
#   ... stop / terminate / redeploy ...
python3 deploy/verify-pod.py snapshot after.json --deep --url <new observer> --host <ip> --port <ssh>
python3 deploy/verify-pod.py compare before.json after.json     # exit 1 if anything regressed
```
`--deep` creates a real session (costs a few cents) and proves OAuth + kernel + Serper together.
