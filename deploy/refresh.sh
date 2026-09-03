#!/usr/bin/env bash
# Refresh / redeploy hook, run by the observer's POST /api/deploy (or by hand).
#
#   git fetch -> compute changed paths -> git pull --ff-only
#   -> npm ci            (only if package-lock.json changed)
#   -> npm run build     (only if packages/** or root build config changed)
#   -> observer build    (only if observer/** changed)
#   -> restart scope:
#        observer-only change  => exit 0; the observer exits 87 and its supervisor restarts it.
#                                 Running agents are untouched.
#        packages/** changed   => also restart the Prime Agent daemon (interrupts in-flight turns;
#                                 sessions stay resumable). Refused while agents are working unless
#                                 REFRESH_FORCE=1.
#        deploy/** changed     => print that a pod/container restart is required.
#
# Prints "::phase <name>" marker lines the UI turns into progress chips. Never echoes env.
set -euo pipefail

ROOT="${OBSERVER_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${REFRESH_BRANCH:-main}"
PRIME_AGENT_BIN="${PRIME_AGENT_BIN:-prime-agent}"
cd "$ROOT"

phase() { echo "::phase $1"; }
log() { echo "[refresh] $*"; }

if [[ -n "${DEPLOY_GIT_SSH_KEY_FILE:-}" && -f "${DEPLOY_GIT_SSH_KEY_FILE}" ]]; then
  export GIT_SSH_COMMAND="ssh -i ${DEPLOY_GIT_SSH_KEY_FILE} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
fi

phase pull
before="$(git rev-parse HEAD)"
log "at $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD); fetching origin/${BRANCH}"
git fetch --quiet origin "$BRANCH"
after="$(git rev-parse "origin/${BRANCH}")"
if [[ "$before" == "$after" ]]; then
  log "already up to date at $(git rev-parse --short HEAD)"
  changed=""
else
  changed="$(git diff --name-only "$before" "$after")"
  log "incoming commits:"
  git log --oneline "${before}..${after}" | sed 's/^/[refresh]   /'
  git pull --ff-only --quiet origin "$BRANCH"
  log "now at $(git rev-parse --short HEAD)"
fi

has_change() { [[ -n "$changed" ]] && grep -qE "$1" <<<"$changed"; }

lock_changed=false; harness_changed=false; observer_changed=false; deploy_changed=false
has_change '^package-lock\.json$|^observer/package-lock\.json$' && lock_changed=true
has_change '^packages/|^package\.json$|^tsconfig' && harness_changed=true
has_change '^observer/' && observer_changed=true
has_change '^deploy/' && deploy_changed=true

# A fresh checkout (or REFRESH_FULL=1) builds everything.
if [[ "${REFRESH_FULL:-0}" == "1" || ! -f packages/coding-agent/dist/bundle/cli.js ]]; then
  lock_changed=true; harness_changed=true; observer_changed=true
fi
if [[ ! -d observer/dist/web ]]; then observer_changed=true; fi

phase install
if $lock_changed; then
  log "lockfile changed: npm ci (root)"
  npm ci --no-audit --no-fund 2>&1 | tail -n 3 | sed 's/^/[refresh]   /'
  log "npm install (observer)"
  (cd observer && npm install --no-audit --no-fund 2>&1 | tail -n 3 | sed 's/^/[refresh]   /')
else
  log "lockfiles unchanged: skipping install"
fi

phase build
if $harness_changed; then
  log "harness sources changed: npm run build (tui -> ai -> agent -> coding-agent)"
  npm run build 2>&1 | tail -n 5 | sed 's/^/[refresh]   /'
else
  log "packages/ unchanged: skipping harness build"
fi
if $observer_changed || $harness_changed; then
  log "building observer"
  (cd observer && npm run build 2>&1 | tail -n 6 | sed 's/^/[refresh]   /')
else
  log "observer unchanged: skipping observer build"
fi

phase restart
if $deploy_changed; then
  log "WARNING: deploy/ changed (entrypoint/refresh). A container restart is required to pick that up."
fi
if $harness_changed; then
  working="$($PRIME_AGENT_BIN list 2>/dev/null | grep -ciE 'working|streaming|running' || true)"
  if [[ "${working:-0}" != "0" && "${REFRESH_FORCE:-0}" != "1" ]]; then
    log "REFUSING to restart the daemon: ${working} agent(s) are working. Re-run with REFRESH_FORCE=1 to interrupt them."
    log "The observer will still restart with the new UI/server code."
  else
    log "restarting the Prime Agent daemon (sessions remain resumable)"
    "$PRIME_AGENT_BIN" shutdown 2>&1 | sed 's/^/[refresh]   /' || true
    # On the pod, entrypoint.sh's supervise loop relaunches the daemon; locally the next
    # prime-agent invocation (or the observer's Start button) does.
  fi
else
  log "packages/ unchanged: daemon and running agents untouched"
fi
log "done; observer will now restart itself"
exit 0
