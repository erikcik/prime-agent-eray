# Checkpoint benchmarks — first live end-to-end run (2026-09-14)

Local Mac, observer build at `2722b3454` + fixes below, port 8791, helpers on Claude Code
`sonnet`, trials on `anthropic/claude-sonnet-4-6` (prime-agent) and `sonnet` (Claude Code).

## What ran, in order

| step | result |
|---|---|
| Source session: "write the App Store subtitle and promo text for Stillpoint" in a workspace holding only `BRIEF.md` | agent wrote one subtitle + one promo into `appstore.md` |
| Workspace recorder | commit on the user message (`BRIEF.md` only); the later message added no commit because nothing had changed (dedupe) |
| Operator types "you should have studied Calm/Headspace/Balance, counted characters, given three options with a recommendation. Benchmark this." into the session | intervention job → task anchored before the original user message, prompt = the original task verbatim, workspace = pre-`appstore.md` state (lag 154 s), desired trajectory extracted faithfully, 9 criteria (7 required) + judge instructions drafted |
| Mine the session | 4 candidates (single-shot copy decision, recovery after correction, choosing to scrape live App Store pages, three-option synthesis) with decision / why / expert alternatives |
| Experiment "research competitors before writing launch copy", 1 helper-written variant | variant is an operational SKILL.md; 4 arms built |
| Run (4 trials, concurrency 4) | finished in 3 m 44 s; no trial daemon or socket left behind |
| Advisor (auto) on a new live session writing the Play Store short description | judged it a major step, chose the verified skill, injected it; the agent redid the step research-first (competitive scan, constraint checklist, 9 options, recommendation) |
| UI | tasks, candidates, experiments, runs, advisor pages render with live data |

## Results

| arm | passed | score | agent cost | judge cost | time |
|---|---|---|---|---|---|
| prime-agent · raw | 0/1 | 0.05 | $0.043 | $0.084 | 11 s |
| claude code · raw | 0/1 | 0.05 | $0.090 | $0.060 | 16 s |
| prime-agent · competitor-research variant | 0/1 | 0.55 | $0.217 | $0.184 | 133 s |
| claude code · competitor-research variant | 1/1 | 0.92 | $0.341 | $0.162 | 88 s |

Both raw harnesses skipped research and wrote one option. With the skill both researched live
(prime-agent via `websearch`, Claude Code via WebSearch + WebFetch). The prime-agent variant arm
failed two *required* criteria the drafter wrote too literally ("exactly three" subtitles, it
wrote four; "Balance" specifically, it studied Insight Timer instead). Lesson: review drafted
criteria before trusting pass rates; the score column is more informative on one repeat.

Whole test incl. helpers ≈ $2.

## Defects found by running it (all fixed)

1. **Trials copied `auth.json`.** A trial refreshed its copy of the Anthropic OAuth login, which
   rotated the refresh token and killed the operator's own login (main daemon: "No API key for
   provider: anthropic"). Trials now receive only static API keys; subscription auth comes from
   `ANTHROPIC_OAUTH_TOKEN`.
2. **Every old session looked active at boot**, so the periodic recorder snapshotted all their
   workspaces. First sight now uses the session file's mtime.
3. **Advisor → intervention feedback loop.** The advisor's injected message mentions benchmarks,
   so the intervention detector captured it as an operator request and created a task from the
   system's own output. Messages carrying the `<benchmark-skill` marker are now ignored.
4. **Observer "Start daemon" (pre-existing).** It spawned `prime-agent daemon start`, a command the
   CLI no longer has. It now spawns `prime-agent --mode daemon --daemon-socket <path>` detached,
   like the CLI launcher; verified on a throwaway socket (hello, targeted shutdown, nothing left).

## Not covered yet

* Repeats > 1 and `current` memory mode against a harness state that actually has entries (the
  Mac's global harness and skills dirs are empty).
* Mid-turn anchors and mined-candidate acceptance through to a run.
* Scheduled re-runs (only verified by unit logic) and cancel / observer-restart recovery live.
* The pod: the image has no `claude` CLI, so Claude Code arms and the default helper backend need
  it installed (or `helper backend: prime-agent`) before this works on RunPod.
