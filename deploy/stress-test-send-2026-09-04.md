# Stress test 2026-09-04 — "can I still talk to my session after a restart?"

The complaint: after restarting the pod, sending a message to a running session fails and the UI
gets stuck. This records what was measured, on real pods, not what was assumed.

Harness: `deploy/stress-send.py` (phases `live,notlive,redeploy,recover`).
Client logic under test: `observer/src/web/lib/send.ts` (+19 unit tests in
`observer/test/send-recovery.test.ts`).

## Two ways the harness used to lie — fixed first

A stress test that reports PASS without exercising the thing is worse than no test.

1. **A skipped phase reported success.** `--phases redeploy` alone printed
   `SKIP no session from the live phase` and then `ALL PHASES PASSED`, exit 0. The most important
   phase could be silently unrun. `Report.skip()` now records skips; the summary prints
   `INCONCLUSIVE` and exits **1**.
2. **The redeploy phases never entered the restart window.** `POST /api/deploy` returns while
   `refresh.sh` is still running, so the first probe hit a fully healthy observer, got 200 and
   "passed" — the observed run was `statuses seen: {'200': 1} … gave up after 0s`. A fixed
   `time.sleep(2)` in the recover phase was the same race. Both now call
   `wait_for_down_window()`, which polls `/api/health` until the observer is actually unreachable
   or its `serverStartedAt` has changed, and **asserts the window was observed**.

Only after those fixes do the results below mean anything.

## Results

Pods `mvps1euzsb737a` and `gmo9sdj2i2dnht`, volume `o6kytzktj0`, image `0.1.2`.

**4 full suite runs · 8 real observer redeploys · 1 real pod terminate+redeploy — all passed.**

| phase | what it proves | result |
|---|---|---|
| live | a fresh session accepts a prompt | PASS |
| notlive | an inactive session refuses `409 session_not_live`, and resume-then-send recovers it | PASS |
| redeploy | every send across the observer-down window eventually lands | PASS — window confirmed via 502; e.g. `{'502/proxy-html': 7, '200': 1}`, delivered at 22s |
| recover | the message lands **exactly once** across a real redeploy | PASS — 1 copy of the marker, every run |

Restart windows actually observed each run: 4, 4, 6 and 7 consecutive `502/proxy-html` before
delivery. Delivery took 12–22 s.

### The real pod restart (the operator's actual scenario)

Terminate `mvps1euzsb737a` → redeploy `gmo9sdj2i2dnht` on the same volume (up in 27 s), then talk
to a session created on the pod that no longer exists:

* the pre-restart message survived — 1 copy, unchanged
* a naive send returned **`409 session_not_live`** — reproducing the exact stuck-UI failure
* the client algorithm recovered it: `409 → resume (200, active) → send` — **delivered in 6 s over
  2 attempts, exactly once**

## Why exactly-once needs a transcript check, not an assumption

An earlier version of this work assumed the RunPod interstitial proved the request never reached
the observer, making a blind re-send safe. That was measured and **found false**: the page is
served while the observer is alive with an unchanged `serverStartedAt`. `send.ts` therefore treats
every failure except an explicit `409` as ambiguous and looks for the message in the transcript
before re-sending. In 5/5 measured interstitials nothing had landed — but "probably undelivered"
is not a basis for an exactly-once guarantee, and the cost of being certain is one extra GET.

Only the `409` is trusted outright, because the observer throws it in `requireLive()` before
touching the daemon — our own code, not proxy behaviour.

## Re-running

```bash
python3 deploy/stress-send.py --url https://<POD_ID>-8790.proxy.runpod.net
```
Exit 0 only when every phase ran and passed. Each full run triggers two real redeploys and takes
several minutes. For the pod-restart case, terminate and redeploy against the same volume, then
send to a session that was live beforehand: it must return 409, resume, and deliver one copy.
