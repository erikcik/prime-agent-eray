#!/usr/bin/env bash
# Pull-mirror the pod's /workspace volume into a folder on this Mac over the image's sshd.
# Pull-only by default and never deletes locally; --push and --delete are explicit opt-ins.
#
#   deploy/pod-mirror.sh --host <POD_IP> --port <MAPPED_22> [--once] [--remote /workspace] [dest]
#   deploy/pod-mirror.sh --pod <POD_ID> ...          # resolve ip/port via runpodctl (if installed)
#
# Defaults: dest ~/Desktop/prime-agent-pod, identity ~/.ssh/lh-harness-pod (no passphrase), 5s loop.
# RunPod remaps the public 22/tcp port on every restart: re-read it (runpod MCP get-pod → portMappings).
set -euo pipefail

HOST=""; PORT=""; POD=""; ONCE=0; PUSH=0; DELETE=0
REMOTE="${MIRROR_REMOTE:-/workspace}"
IDENTITY="${MIRROR_IDENTITY:-$HOME/.ssh/lh-harness-pod}"
INTERVAL="${MIRROR_INTERVAL:-5}"
USER_="${MIRROR_USER:-node}"
DEST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --pod) POD="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --push) PUSH=1; shift ;;
    --delete) DELETE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) DEST="$1"; shift ;;
  esac
done
DEST="${DEST:-$HOME/Desktop/prime-agent-pod}"

if [[ -n "$POD" && ( -z "$HOST" || -z "$PORT" ) ]]; then
  if command -v runpodctl >/dev/null 2>&1; then
    # runpodctl prints "ip:port" pairs; pick the mapping for container port 22.
    mapping="$(runpodctl get pod "$POD" -a 2>/dev/null | grep -oE '[0-9.]+:[0-9]+->22' | head -1 || true)"
    HOST="${HOST:-${mapping%%:*}}"; PORT="${PORT:-$(sed -E 's/^[0-9.]+:([0-9]+)->22$/\1/' <<<"$mapping")}"
  fi
fi
[[ -n "$HOST" && -n "$PORT" ]] || { echo "need --host and --port (or --pod with runpodctl)"; exit 2; }
[[ -f "$IDENTITY" ]] || { echo "identity $IDENTITY not found"; exit 2; }

SSH_OPTS=(-p "$PORT" -i "$IDENTITY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -o ServerAliveCountMax=6 -o ConnectTimeout=15)
RSYNC_OPTS=(--archive --compress --partial --human-readable --timeout=120 --exclude '.git/' --exclude 'node_modules/' --exclude 'kernel-venv/' --exclude '*.sock' --exclude '.DS_Store' --exclude '__pycache__/' --exclude 'state/deploy_key')
[[ "$DELETE" == "1" ]] && RSYNC_OPTS+=(--delete)

mkdir -p "$DEST"
sync_once() {
  if [[ "$PUSH" == "1" ]]; then
    rsync "${RSYNC_OPTS[@]}" -e "ssh ${SSH_OPTS[*]}" "$DEST/" "$USER_@$HOST:$REMOTE/"
  else
    rsync "${RSYNC_OPTS[@]}" -e "ssh ${SSH_OPTS[*]}" "$USER_@$HOST:$REMOTE/" "$DEST/"
  fi
}

echo "[mirror] $( [[ $PUSH == 1 ]] && echo push || echo pull ) $USER_@$HOST:$PORT:$REMOTE  <->  $DEST"
fails=0
while true; do
  if sync_once; then
    fails=0; echo "[mirror] synced $(date '+%H:%M:%S')"
  else
    fails=$((fails + 1)); echo "[mirror] rsync failed ($fails)"; [[ $fails -ge 20 ]] && { echo "[mirror] giving up"; exit 1; }
  fi
  [[ "$ONCE" == "1" ]] && exit 0
  sleep "$INTERVAL"
done
