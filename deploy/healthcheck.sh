#!/usr/bin/env bash
# Only meaningful while `serve` is running (marker written by entrypoint once the observer listens).
set -u
marker=/tmp/observer-serving
[[ -f "$marker" ]] || exit 0
port="$(cat "$marker" 2>/dev/null || echo 8790)"
curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" >/dev/null || exit 1
