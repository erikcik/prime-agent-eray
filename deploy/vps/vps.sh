#!/usr/bin/env bash
# The prime sandbox on a plain VPS (Hetzner CX33): the same image and entrypoint as the RunPod pod,
# run with Docker on the host network. Driven from this Mac over ssh (`Host prime-vps` in ~/.ssh/config).
#
#   deploy/vps/vps.sh secrets   push deploy/.env (+ the M1 API key) to /etc/prime-agent/ (root, 0600)
#   deploy/vps/vps.sh build     clone/pull the repo on the VPS and `docker build` the image there
#   deploy/vps/vps.sh up        (re)create the container; secrets + build first if missing
#   deploy/vps/vps.sh m1        add the m1-lab provider to the sandbox's models.json
#   deploy/vps/vps.sh status | logs [n]
#
# Layout on the VPS:
#   /etc/prime-agent/env              docker env-file (one line per key; no multi-line values)
#   /etc/prime-agent/deploy_key       GitHub deploy key (read-only on the repo), passed as env at run
#   /etc/prime-agent/m1-lab-api-key   M1 llama-server key, mounted read-only at /run/secrets/
#   /opt/prime-agent/src              checkout used for `docker build`
#   /srv/prime-agent                  /workspace in the container (app, agent dir, project, state)
#
# Differences from the pod: no container sshd (PUBLIC_KEY dropped; the host's sshd is the entry, and
# `prime` uses `docker exec`), the observer binds 127.0.0.1 (reach it with `prime web`, an ssh
# tunnel), and there is no RUNPOD_POD_ID, so the observer's idle stop stays off (flat-rate VPS).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(dirname "$HERE")"
VPS="${PRIME_VPS:-prime-vps}"
IMAGE=prime-agent:local
NAME=prime-agent

remote() { ssh -o BatchMode=yes "$VPS" "$@"; }

cmd_secrets() {
  local json
  json="$("$DEPLOY/env-json.sh" | tail -1)"
  # Values travel over ssh stdin straight into 0600 files; nothing is echoed.
  python3 - "$json" <<'PY' | remote 'set -e; umask 077; mkdir -p /etc/prime-agent; cat > /etc/prime-agent/.incoming.json; python3 - <<"EOF"
import json, os
d = json.load(open("/etc/prime-agent/.incoming.json"))
os.remove("/etc/prime-agent/.incoming.json")
key = d.pop("DEPLOY_GIT_SSH_KEY", "")
if key:
    with open("/etc/prime-agent/deploy_key", "w") as f:
        f.write(key.strip() + "\n")
with open("/etc/prime-agent/env", "w") as f:
    for k, v in d.items():
        if "\n" in v:
            raise SystemExit(f"{k} is multi-line; docker env-files cannot carry it")
        f.write(f"{k}={v}\n")
print("wrote", len(d), "keys:", " ".join(sorted(d)))
EOF'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ("PUBLIC_KEY", "PRIME_OBSERVER_ALLOWED_ORIGINS"):
    d.pop(k, None)
d["PRIME_OBSERVER_HOST"] = "127.0.0.1"
json.dump(d, sys.stdout)
PY
  rm -f "$json"
  local m1key="$HOME/.config/m1-lab/api-key"
  if [[ -f "$m1key" ]]; then
    remote 'umask 077; cat > /etc/prime-agent/m1-lab-api-key; chown 1000:1000 /etc/prime-agent/m1-lab-api-key; chmod 400 /etc/prime-agent/m1-lab-api-key' <"$m1key"
    echo "m1-lab api key installed"
  fi
}

cmd_build() {
  remote 'set -e
    export GIT_SSH_COMMAND="ssh -i /etc/prime-agent/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    if [ -d /opt/prime-agent/src/.git ]; then git -C /opt/prime-agent/src pull --ff-only -q
    else mkdir -p /opt/prime-agent && git clone -q git@github.com:erikcik/prime-agent-eray.git /opt/prime-agent/src; fi
    cd /opt/prime-agent/src && echo "building at $(git rev-parse --short HEAD)"
    docker build -q -f deploy/Dockerfile -t '"$IMAGE"' . '
}

cmd_up() {
  remote '[ -f /etc/prime-agent/env ]' || cmd_secrets
  remote "docker image inspect $IMAGE >/dev/null 2>&1" || cmd_build
  remote 'set -e
    mkdir -p /srv/prime-agent
    docker rm -f '"$NAME"' >/dev/null 2>&1 || true
    m1=""; [ -f /etc/prime-agent/m1-lab-api-key ] && m1="-v /etc/prime-agent/m1-lab-api-key:/run/secrets/m1-lab-api-key:ro"
    docker run -d --name '"$NAME"' --restart unless-stopped --network host \
      --env-file /etc/prime-agent/env -e DEPLOY_GIT_SSH_KEY="$(cat /etc/prime-agent/deploy_key)" \
      -v /srv/prime-agent:/workspace $m1 '"$IMAGE"' >/dev/null
    echo "container started"'
  echo "waiting for the observer..."
  for _ in $(seq 1 120); do
    if remote 'curl -sf -o /dev/null http://127.0.0.1:8790/api/health'; then echo "observer up"; return; fi
    sleep 5
  done
  echo "observer did not come up in 10 min; see: deploy/vps/vps.sh logs" >&2
  return 1
}

cmd_m1() {
  # Same provider as this Mac's (written by deploy/m1-lab/provider.mjs), except the key comes from
  # the mounted secret. Only structure is copied; the Mac's entry already holds no key.
  python3 - "$HOME/.prime/agent/models.json" <<'PY' | remote 'docker exec -i -u node prime-agent python3 -c "
import json, sys
p = \"/workspace/prime/agent/models.json\"
try:
    cfg = json.load(open(p))
except FileNotFoundError:
    cfg = {\"providers\": {}}
cfg.setdefault(\"providers\", {})[\"m1-lab\"] = json.load(sys.stdin)
json.dump(cfg, open(p, \"w\"), indent=2)
print(\"m1-lab provider written to\", p)
"'
import json, sys
entry = json.load(open(sys.argv[1]))["providers"]["m1-lab"]
entry["apiKey"] = "!cat /run/secrets/m1-lab-api-key"
entry["name"] = "M1 lab (llama.cpp via prime link)"
json.dump(entry, sys.stdout)
PY
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  build) cmd_build ;;
  up) cmd_up ;;
  m1) cmd_m1 ;;
  status) remote "docker ps --filter name=$NAME --format '{{.Names}} {{.Status}} {{.Image}}'; curl -s http://127.0.0.1:8790/api/health; echo" ;;
  logs) remote "docker logs --tail ${2:-80} $NAME 2>&1" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
