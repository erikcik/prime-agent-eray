#!/usr/bin/env bash
# Supervisor loop for the observer: restart immediately on exit 87 (redeploy requested),
# back off on crashes, stop cleanly on exit 0. Used locally and by deploy/entrypoint.sh.
#
#   PRIME_OBSERVER_TOKEN=... deploy/run-observer.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PRIME_OBSERVER_REPO_ROOT="${PRIME_OBSERVER_REPO_ROOT:-$ROOT}"
export PRIME_OBSERVER_DEPLOY_HOOK="${PRIME_OBSERVER_DEPLOY_HOOK:-$ROOT/deploy/refresh.sh}"
backoff=2
while true; do
  node "$ROOT/observer/dist/server/main.js"
  code=$?
  if [[ $code -eq 0 ]]; then
    echo "[run-observer] observer exited cleanly"; exit 0
  elif [[ $code -eq 87 ]]; then
    echo "[run-observer] redeploy requested; restarting observer"; backoff=2; continue
  else
    echo "[run-observer] observer crashed (exit $code); restarting in ${backoff}s"
    sleep "$backoff"; backoff=$(( backoff * 2 )); [[ $backoff -gt 60 ]] && backoff=60
  fi
done
