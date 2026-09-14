# prime · observer

A sidecar web UI for Prime Agent. It never modifies anything under `packages/`; it observes the
daemon over its unix socket (public exports of `@earendil-works/pi-coding-agent`) and reads the
on-disk session and Continual Harness state.

Pages: **signal** (fleet counters, family boards, live ticker, new session), **lineage** (RLM spawn
tree incl. deleted children), **session** page (the real `prime-agent` terminal attached to the
session, plus abort/kill, stats, children, goal, queue, schedules, local harness), **comms** (agent-to-agent messages), **harness** (entries by kind, refinement history
with before/after diffs and rollback, installed skills with rendered SKILL.md), **schedules**
(cron + heartbeats), **ops** (versions, daemon start/restart/shutdown, deploy console, daemon log).
The **Redeploy** button runs `deploy/refresh.sh` and restarts the observer (exit code 87).

## Run

```bash
cd observer && npm install && npm run build
PRIME_OBSERVER_TOKEN=$(openssl rand -hex 24) ../deploy/run-observer.sh     # http://127.0.0.1:8790
# loopback dev without a token:
PRIME_OBSERVER_INSECURE_LOCAL=1 node dist/server/main.js
```

| env | default | meaning |
|---|---|---|
| `PRIME_OBSERVER_TOKEN` | required | bearer for the API + WebSocket (>= 16 chars) |
| `PRIME_OBSERVER_INSECURE_LOCAL` | – | `1` allows no token when bound to loopback |
| `PRIME_OBSERVER_PORT` / `HOST` | 8790 / 127.0.0.1 | bind address (`0.0.0.0` on the pod) |
| `PRIME_OBSERVER_ALLOWED_ORIGINS` | auto | extra WebSocket origins; RunPod proxy origin derived from `RUNPOD_POD_ID` |
| `PRIME_AGENT_CODING_AGENT_DIR` | `~/.prime/agent` | same dir the harness uses |
| `PRIME_AGENT_DAEMON_SOCKET` | harness default | daemon socket path |
| `PRIME_OBSERVER_DEPLOY_HOOK` | `deploy/refresh.sh` | script run by Redeploy |
| `PRIME_OBSERVER_PRIME_AGENT_BIN` | `prime-agent` | used by the Start-daemon button |

## Develop

```bash
npm run dev:server   # tsx watch
npm run dev:web      # vite on :5173, proxies /api and /ws to :8790
npm run check && npm test
```

Tests use `test/fixtures/agent-dir` (paths carry a `__AGENT_DIR__` placeholder materialized into a
temp dir) and boot the real server with the daemon offline.

## Session terminal

The session page does not re-implement the transcript. It hosts the harness's own TUI: the
observer spawns `prime-agent --resume <session file>` in a PTY (node-pty) and streams the bytes to
an xterm.js view over `GET /ws/term?session=<id>` (bearer in the WebSocket subprotocol, same origin
allow-list as `/ws`). When the session is live the TUI attaches to the resident worker; when it is
saved it resumes it. Closing the page kills the TUI process only, never the agent. Every TUI
behaviour is therefore the harness's: Esc Esc / `/tree` for branch navigation, `/fork`, Ctrl+O and
Ctrl+T for tool output and thinking, Ctrl+C to abort, steering by typing mid-turn.

- The PTY runs `PRIME_OBSERVER_PRIME_AGENT_BIN` with `--daemon-socket` when the observer has one,
  in the session's cwd (falling back to the repo root), with `PRIME_AGENT_CODING_AGENT_DIR` set and
  the observer's own secrets stripped from the environment.
- At most 8 terminals at once (each TUI is a ~200 MB Node process); the ninth is refused with
  close code 4429.
- `node-pty` ships no Linux prebuild, so the image installs `make` and `g++`; `npm ci` compiles it.

## Composer attachments

**Attach files** under the terminal streams each file to `<session cwd>/inbox/<name>` and shows the
cwd-relative path, which you then mention in the terminal like any other path (the model only ever
sees message text):

```
Attached files (already uploaded to this session's `inbox/` folder; open them with these
cwd-relative paths):
- inbox/brief.pdf (2.4 MB)
```

`POST /api/uploads?session=<id>` takes a **raw body** with the file name in `X-File-Name`
(URI-encoded) — deliberately not multipart. `GET /api/uploads?session=<id>` lists the inbox.
Cap: `PRIME_OBSERVER_MAX_UPLOAD_BYTES`, default 512 MB.

Three rules are load-bearing here, each learned from ai-ceo-1's `/api/uploads`:

* **Stream, never buffer.** The handler pipes the request to a `.part` file and renames it only on
  completion, so an aborted upload cannot leave a truncated file that looks whole. It never calls
  `ctx.body()`, whose 4 MB in-memory cap exists for control JSON.
* **Drain, don't destroy, when rejecting.** Answering 413/422 without reading the rest of the body
  leaves the client blocked on a write nobody consumes — that is what "uploads time out" actually
  was. Destroying the request is the opposite mistake: it kills the socket before the status is
  written and the client sees a bare transport error. Only `req.resume()` delivers a real status.
* **Bound size, not time.** `server.requestTimeout` is disabled in `main.ts`; Node's 300 s default
  silently aborted large uploads mid-body on a slow uplink. `headersTimeout` still guards slowloris.

Through the RunPod proxy, Cloudflare rejects bodies over ~100 MB before the observer ever sees
them, regardless of the cap above.

## Checkpoint benchmarks (`/bench`)

Harness changes are tested against benchmarks built from real session trajectories instead of
being assumed. The loop: freeze the moments that matter, write down what "right" looks like,
run harness variants against them next to the raw harnesses, re-run weekly, and plug the
variants that win back into live sessions. Server code: `src/server/bench/`; UI: `src/web/pages/bench/`.

**Capture a checkpoint** (tasks tab, session rail "bench" tab, or by telling a live agent
"… benchmark this"). A task freezes:

* the session's current branch cut at an anchor, as a forkable session file (anchored at a user
  message: that message becomes the prompt; anchored mid-turn: the agent is asked to continue);
* harness memory (`harness_state.json`, global + session-local) rewound to the anchor time:
  entries created or edited afterwards are excluded, so a run can never read the memory the
  original session wrote about its own solution; skills created or edited afterwards likewise;
* `settings.json` and `models.json` (never credentials);
* the workspace, from a shadow-git recorder (`bench/shadow/<cwd-hash>.git`, work tree = the cwd,
  the project's own `.git` is never touched) that records on every user message and every few
  minutes while a session is active. The UI shows how far the recorded state lags the anchor.

A helper drafts goal, final-state criteria (required/optional) and judge instructions; the
operator's desired trajectory is kept judge-only. Everything is editable; a task needs criteria
before it can run. Helpers write very literal criteria: review them.

**Mine** a finished session: a helper windows the trajectory and proposes major decisions
(with nearby screenshots) as candidates; accepting one captures a task.

**Experiments**: describe the change; a helper writes N variants as SKILL.md. Arms are
harness × variant × model × memory mode (`snapshot` = as at the checkpoint, `current` = today's
memory minus what the capture proved was written later, `none`). Defaults: raw prime-agent, raw
Claude Code, and each variant on each harness. A variant is inserted verbatim, identically on
both harnesses (system prompt or first message).

* prime-agent trials: isolated agent dir, `--fork` of the frozen transcript, their own daemon on a
  short socket under `/tmp/prime-bench/` stopped by a targeted `shutdown` (never
  `prime-agent shutdown --force`, which stops every daemon on the machine).
* Claude Code trials: fresh private `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_OAUTH_TOKEN`, so personal
  CLAUDE.md/skills/plugins cannot leak into the baseline; the frozen transcript is rendered into
  `--append-system-prompt-file`.
* Judge: a read-only helper in the trial's final workspace with a git diff of what changed;
  required criteria are enforced server-side regardless of the judge's own `passed`.

Results: per-arm pass rate, score, cost and time, a task × arm matrix, and per-run history.
Each run records repo commit, harness version, Claude Code version and a memory stamp, because
those change underneath between weekly re-runs (`schedule.everyDays`; only experiments that were
run by hand once are re-run automatically). "Install as a live skill" writes the variant into the
global skills dir.

**Advisor** (off by default): every N minutes it reads what each live session did since its last
look; when a major step starts that a verified skill fits (latest run beats the matching raw arm
by `minLift`), the skill is sent in (`auto`, via steer mid-turn or follow-up) or queued (`suggest`).

| requirement | why |
|---|---|
| `ANTHROPIC_OAUTH_TOKEN` (from `claude setup-token`) in the observer env | subscription auth for trials and helpers. OAuth logins in `auth.json` are deliberately never copied into trials: refresh tokens rotate, and a trial refreshing its copy kills the operator's login. |
| `claude` on PATH | default helper backend and the Claude Code arms (`settings → helper backend: prime-agent` avoids it for helpers) |
| `git`, `tar` | workspace recorder and trial workspaces |

Data lives under `<agent dir>/observer/bench/` (`tasks/<id>/{task.json,snapshot/}`, `candidates/`,
`experiments/`, `runs/<id>/{run.json,trials/<id>/}`, `shadow/`, `advisor/`, `settings.json`).
Trials interrupted by an observer restart are marked as errors, not resumed.
