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
