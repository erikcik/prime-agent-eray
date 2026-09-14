#!/usr/bin/env bash
# Install (once) and start JupyterLab on the prime-agent pod, served through the RunPod HTTP proxy.
#
#   deploy/pod-jupyter.sh --pod <POD_ID> [--port 8888] [--stop]
#
# Why it is a script and not part of the image: the JupyterLab venv lives on CONTAINER disk
# (/opt/prime-agent/jupyter-venv), because RunPod network volumes ignore chmod and that breaks a
# venv's executables — the same reason the harness kernel venv is baked there. Container disk does
# not survive a pod recreation, so this reinstalls in ~1 min with uv whenever the pod is new.
#
# The pod must expose the port as http at CREATION time (runpod-deploy.py sends 8888/http); RunPod
# cannot add a port to a live pod. Jupyter binds 0.0.0.0 so the proxy can reach it, and is protected
# by a token — the proxy URL is public, exactly like the observer's.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POD=""; PORT="${JUPYTER_PORT:-8888}"; STOP=0
IDENTITY="${MIRROR_IDENTITY:-$HOME/.ssh/prime-agent-pod}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pod) POD="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --stop) STOP=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[[ -n "$POD" ]] || { echo "need --pod <POD_ID>" >&2; exit 2; }

# RunPod remaps the public 22/tcp port on every restart, so resolve it fresh every time.
mapping="$(runpodctl get pod "$POD" -a 2>/dev/null | grep -oE '[0-9.]+:[0-9]+->22' | head -1 || true)"
[[ -n "$mapping" ]] || { echo "could not resolve the ssh mapping for $POD (is it running?)" >&2; exit 1; }
HOST="${mapping%%:*}"; SSH_PORT="$(sed -E 's/^[0-9.]+:([0-9]+)->22$/\1/' <<<"$mapping")"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new -i "$IDENTITY" -p "$SSH_PORT" "node@$HOST")

# NOTE: never pkill on a pattern that also matches this script's own command line — "jupyter-lab"
# does, and pkill -f then kills the shell that is trying to start it. Match the venv path instead.
if [[ "$STOP" == "1" ]]; then
  "${SSH[@]}" "pkill -f '/opt/prime-agent/jupyter-venv/bin/jupyter' || true; echo stopped"
  exit 0
fi

tokfile="$here/.jupyter-token"
if [[ ! -f "$tokfile" ]]; then
  python3 -c "import secrets;print(secrets.token_urlsafe(24))" >"$tokfile"; chmod 600 "$tokfile"
fi
TOKEN="$(cat "$tokfile")"

echo "[jupyter] pod $POD via $HOST:$SSH_PORT"
"${SSH[@]}" "set -e
export PATH=/usr/local/bin:\$PATH
V=/opt/prime-agent/jupyter-venv
if [ ! -x \"\$V/bin/jupyter\" ]; then
  echo '[jupyter] installing (container disk, ~1 min)'
  uv venv \"\$V\" --python 3.11 >/dev/null 2>&1 || true
  VIRTUAL_ENV=\"\$V\" uv pip install --quiet jupyterlab
fi
cat > /opt/prime-agent/jupyterd.py <<'EOS'
import os, sys
LOG = '/workspace/state/jupyter.log'
BIN = '/opt/prime-agent/jupyter-venv/bin/jupyter'
os.makedirs(os.path.dirname(LOG), exist_ok=True)
if os.fork() > 0: sys.exit(0)
os.setsid()
if os.fork() > 0: os._exit(0)
fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(os.open(os.devnull, os.O_RDONLY), 0); os.dup2(fd, 1); os.dup2(fd, 2)
os.execv(BIN, [BIN, 'lab', '--no-browser',
               '--ip', '0.0.0.0', '--port', os.environ['JUPYTER_PORT'],
               '--ServerApp.token=' + os.environ['JUPYTER_TOKEN'],
               '--ServerApp.root_dir=/workspace',
               '--ServerApp.allow_origin=*',
               '--ServerApp.trust_xheaders=True'])
EOS
pkill -f '/opt/prime-agent/jupyter-venv/bin/jupyter' 2>/dev/null || true
sleep 1
JUPYTER_TOKEN='$TOKEN' JUPYTER_PORT='$PORT' \"\$V/bin/python\" /opt/prime-agent/jupyterd.py
sleep 9
echo \"[jupyter] local probe: \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/lab)\"
grep -m1 'running at' /workspace/state/jupyter.log || tail -3 /workspace/state/jupyter.log"

echo
echo "  open:  https://${POD}-${PORT}.proxy.runpod.net/lab?token=${TOKEN}"
echo "  stop:  deploy/pod-jupyter.sh --pod ${POD} --stop"
