#!/usr/bin/env bash
# Container entrypoint for Prime Agent + observer on a RunPod CPU pod (or docker compose).
#
#   serve (default)  clone/update the repo on the volume, build if needed, then supervise
#                    the Prime Agent daemon and the observer web server (exit 87 = restart now)
#   shell            interactive bash as `node`
#   refresh          run deploy/refresh.sh once
#   doctor           print layout + versions and exit
#   <anything else>  exec'd as `node` (e.g. `prime-agent -p "..."`)
#
# Volume layout (/workspace):
#   app/          git checkout (git pull target for the observer's Refresh button)
#   prime/agent/  PRIME_AGENT_CODING_AGENT_DIR (models.json, sessions, artifacts, logs; never auth.json)
#   project/      the agents' working directory
#   state/ssh/    sshd host keys (the GitHub deploy key stays on container disk in ~/.ssh)
#
# Credentials come from pod ENV only (RunPod volumes ignore chmod): PRIME_OBSERVER_TOKEN,
# NANO_GPT_API_KEY, ANTHROPIC_OAUTH_TOKEN, DEPLOY_GIT_SSH_KEY, PUBLIC_KEY (ssh authorized key).
set -euo pipefail

VOLUME="${DEPLOY_VOLUME:-/workspace}"
APP_DIR="${DEPLOY_APP_DIR:-$VOLUME/app}"
AGENT_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$VOLUME/prime/agent}"
PROJECT_DIR="${DEPLOY_PROJECT_DIR:-$VOLUME/project}"
STATE_DIR="${DEPLOY_STATE_DIR:-$VOLUME/state}"
REPO_URL="${DEPLOY_REPO_URL:-git@github.com:erikcik/prime-agent-eray.git}"
REPO_BRANCH="${DEPLOY_REPO_BRANCH:-main}"
OBSERVER_PORT="${PRIME_OBSERVER_PORT:-8790}"
RUN_UID=1000
RUN_USER=node

log() { echo "[entrypoint] $*"; }
warn() { echo "[entrypoint] WARNING: $*" >&2; }
# Minimal JSON string literal (escapes \ and ") for the settings seed below.
json_str() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }

cmd="${1:-serve}"

# ---------------------------------------------------------------------------------------------
# Root phase: ownership, sshd, then drop to node and re-exec under tini.
# ---------------------------------------------------------------------------------------------
if [[ "$(id -u)" == "0" ]]; then
  for d in "$VOLUME" "$APP_DIR" "$AGENT_DIR" "$PROJECT_DIR" "$STATE_DIR" "$STATE_DIR/ssh"; do
    mkdir -p "$d" 2>/dev/null || true
    if ! chown "$RUN_UID:$RUN_UID" "$d" 2>/dev/null; then
      chmod 0777 "$d" 2>/dev/null || true
      warn "could not chown $d (root-squashed volume?); made it world-writable instead"
    fi
  done
  # Test whether chmod is honoured on the volume (RunPod network volumes: it is not).
  probe="$STATE_DIR/.mode-probe"; : >"$probe"; chmod 600 "$probe" 2>/dev/null || true
  mode="$(stat -c %a "$probe" 2>/dev/null || echo '?')"; rm -f "$probe"
  if [[ "$mode" != "600" ]]; then
    warn "chmod is a no-op on $VOLUME (probe read back $mode). Never store secrets on the volume; use pod env vars."
  fi
  if [[ -f "$AGENT_DIR/auth.json" ]]; then
    warn "$AGENT_DIR/auth.json exists on the volume — it is world-readable here. Prefer env vars (NANO_GPT_API_KEY, ANTHROPIC_OAUTH_TOKEN)."
  fi

  if [[ "$cmd" == "serve" && -n "${PUBLIC_KEY:-${DEPLOY_SSH_PUBLIC_KEY:-}}" ]]; then
    for t in ed25519 rsa; do
      if [[ ! -f "$STATE_DIR/ssh/ssh_host_${t}_key" ]]; then
        ssh-keygen -q -t "$t" -N "" -f "$STATE_DIR/ssh/ssh_host_${t}_key" >/dev/null
        log "generated ssh host key ($t) on the volume"
      fi
      cp "$STATE_DIR/ssh/ssh_host_${t}_key" "$STATE_DIR/ssh/ssh_host_${t}_key.pub" /etc/ssh/
      chmod 600 "/etc/ssh/ssh_host_${t}_key"
    done
    mkdir -p /home/node/.ssh
    printf '%s\n' "${PUBLIC_KEY:-${DEPLOY_SSH_PUBLIC_KEY}}" >/home/node/.ssh/authorized_keys
    chown -R "$RUN_UID:$RUN_UID" /home/node/.ssh; chmod 700 /home/node/.ssh; chmod 600 /home/node/.ssh/authorized_keys
    /usr/sbin/sshd -e
    log "sshd listening on :22 (user node, key-only); fingerprint: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
  fi
  exec gosu "$RUN_USER" /usr/bin/tini -g -- "$0" "$@"
fi

# ---------------------------------------------------------------------------------------------
# Node phase.
# ---------------------------------------------------------------------------------------------
export HOME=/home/node
export PRIME_AGENT_CODING_AGENT_DIR="$AGENT_DIR"
export PATH="$APP_DIR/node_modules/.bin:$PATH"
mkdir -p "$AGENT_DIR" "$PROJECT_DIR" "$STATE_DIR"

# Agents must never see the RunPod control-plane key (it can delete this pod and its volume).
unset RUNPOD_API_KEY

# Deploy key for the private repo, delivered via env. It lives on CONTAINER disk (~/.ssh), never on the
# volume: RunPod network volumes ignore chmod, so a key there reads back 0666 and ssh refuses it.
rm -f "$STATE_DIR/deploy_key" 2>/dev/null || true
if [[ -n "${DEPLOY_GIT_SSH_KEY:-}" ]]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  printf '%s\n' "$DEPLOY_GIT_SSH_KEY" >"$HOME/.ssh/deploy_key"
  chmod 600 "$HOME/.ssh/deploy_key"
  export DEPLOY_GIT_SSH_KEY_FILE="$HOME/.ssh/deploy_key"
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
  unset DEPLOY_GIT_SSH_KEY
fi

# Observer origins behind the RunPod proxy (it rewrites Host, so the page origin must be allow-listed).
# Append rather than only-set-if-empty: a stray PRIME_OBSERVER_ALLOWED_ORIGINS carried over from the
# local compose rehearsal (127.0.0.1:8791) would otherwise shadow the proxy origin and break the UI's WS.
if [[ -n "${RUNPOD_POD_ID:-}" ]]; then
  proxy_origin="https://${RUNPOD_POD_ID}-${OBSERVER_PORT}.proxy.runpod.net"
  if [[ ",${PRIME_OBSERVER_ALLOWED_ORIGINS:-}," != *",${proxy_origin},"* ]]; then
    export PRIME_OBSERVER_ALLOWED_ORIGINS="${PRIME_OBSERVER_ALLOWED_ORIGINS:+${PRIME_OBSERVER_ALLOWED_ORIGINS},}${proxy_origin}"
  fi
fi

ensure_checkout() {
  if [[ ! -d "$APP_DIR/.git" ]]; then
    log "cloning $REPO_URL ($REPO_BRANCH) into $APP_DIR"
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  git -C "$APP_DIR" config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
}

ensure_built() {
  cd "$APP_DIR"
  local need=0
  [[ -d node_modules ]] || need=1
  [[ -f packages/coding-agent/dist/bundle/cli.js ]] || need=1
  [[ -f observer/dist/server/main.js && -d observer/dist/web ]] || need=1
  if [[ "$need" == "1" || "${DEPLOY_FORCE_BUILD:-0}" == "1" ]]; then
    log "building harness + observer (first boot on this volume; uses the warmed npm cache)"
    npm ci --no-audit --no-fund
    npm run build
    (cd observer && npm install --no-audit --no-fund && npm run build)
  fi
  # A default provider catalog for the pod, if none exists yet.
  if [[ ! -f "$AGENT_DIR/models.json" && -f deploy/models.json ]]; then
    cp deploy/models.json "$AGENT_DIR/models.json"
    log "installed deploy/models.json -> $AGENT_DIR/models.json"
  fi
  # A default model for a fresh volume, if the agent has no settings yet. Without this the harness
  # falls back to prime-inference, which 402s on an empty Prime balance. Override per-pod with
  # DEPLOY_DEFAULT_PROVIDER / DEPLOY_DEFAULT_MODEL (no image rebuild needed).
  if [[ ! -f "$AGENT_DIR/settings.json" ]]; then
    local prov="${DEPLOY_DEFAULT_PROVIDER:-}" model="${DEPLOY_DEFAULT_MODEL:-}"
    if [[ -z "$prov" ]]; then
      if [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]]; then
        prov=anthropic; model="${model:-claude-opus-5}"
      elif [[ -n "${NANO_GPT_API_KEY:-}" ]]; then
        prov=nano-gpt; model="${model:-abliteration-ai/abliterated-model-large-v2}"
      fi
    fi
    if [[ -n "$prov" && -n "$model" ]]; then
      printf '{\n  "defaultProvider": %s,\n  "defaultModel": %s\n}\n' \
        "$(json_str "$prov")" "$(json_str "$model")" >"$AGENT_DIR/settings.json"
      log "seeded $AGENT_DIR/settings.json -> $prov/$model"
    fi
  fi
  # Make `prime-agent` resolvable for scripts and the observer's daemon start.
  mkdir -p "$HOME/.local/bin"
  cat >"$HOME/.local/bin/prime-agent" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/packages/coding-agent/dist/bundle/cli.js" "\$@"
EOF
  chmod +x "$HOME/.local/bin/prime-agent"
  export PATH="$HOME/.local/bin:$PATH"
}

banner() {
  log "----------------------------------------------------------------"
  log "app:       $APP_DIR ($(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?'))"
  log "agent dir: $AGENT_DIR"
  log "project:   $PROJECT_DIR"
  log "observer:  http://0.0.0.0:${OBSERVER_PORT}/  origins: ${PRIME_OBSERVER_ALLOWED_ORIGINS:-loopback}"
  log "models:    $( [[ -n "${NANO_GPT_API_KEY:-}" ]] && echo -n 'nano-gpt ' )$( [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]] && echo -n 'anthropic ' )"
  log "token:     $( [[ -n "${PRIME_OBSERVER_TOKEN:-}" ]] && echo 'set' || echo 'MISSING (observer will refuse to start)')"
  log "----------------------------------------------------------------"
}

supervise_daemon() {
  local backoff=2
  while true; do
    log "starting prime-agent daemon"
    prime-agent --mode daemon
    code=$?
    if [[ $code -eq 0 || $code -eq 87 ]]; then
      log "daemon exited ($code); restarting immediately"; backoff=2
    else
      log "daemon crashed ($code); restarting in ${backoff}s"; sleep "$backoff"; backoff=$(( backoff * 2 )); [[ $backoff -gt 60 ]] && backoff=60
    fi
  done
}

serve() {
  ensure_checkout
  ensure_built
  banner
  cd "$PROJECT_DIR"
  export PRIME_OBSERVER_REPO_ROOT="$APP_DIR"
  export PRIME_OBSERVER_DEPLOY_HOOK="$APP_DIR/deploy/refresh.sh"
  export PRIME_OBSERVER_PRIME_AGENT_BIN="$HOME/.local/bin/prime-agent"
  export PRIME_AGENT_BIN="$HOME/.local/bin/prime-agent"
  supervise_daemon &
  echo "$OBSERVER_PORT" >/tmp/observer-serving
  # run-observer.sh restarts on exit 87 (redeploy) and backs off on crashes.
  exec bash "$APP_DIR/deploy/run-observer.sh"
}

case "$cmd" in
  serve) serve ;;
  shell) ensure_checkout; ensure_built; cd "$PROJECT_DIR"; exec bash ;;
  refresh) ensure_checkout; ensure_built; exec bash "$APP_DIR/deploy/refresh.sh" ;;
  doctor) ensure_checkout; ensure_built; banner; prime-agent --version; node --version; uv --version; "$PRIME_AGENT_KERNEL_VENV/bin/python" --version ;;
  *) ensure_checkout; ensure_built; cd "$PROJECT_DIR"; exec "$@" ;;
esac
