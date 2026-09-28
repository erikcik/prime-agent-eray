#!/bin/bash
# Runs ON the M1. Installed to $M1_LAB_DIR by `m1-lab.sh install` and driven over SSH.
# Needs only what stock macOS ships: bash 3.2, curl, shasum, tar, caffeinate.
#
#   remote.sh probe | install | pull <profile> | pull-status | start <profile> | stop | status | logs [n]

set -u

# Non-interactive SSH sessions do not load the login profile that puts Homebrew on PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

M1_LAB_DIR="${M1_LAB_DIR:-$HOME/m1-lab}"
M1_LAB_PORT="${M1_LAB_PORT:-8080}"
M1_LAB_LLAMA_BUILD="${M1_LAB_LLAMA_BUILD:-b11146}"
M1_LAB_PARALLEL="${M1_LAB_PARALLEL:-2}"
# Direct mode (no SSH access): listen on the network, protected by an API key.
M1_LAB_BIND="${M1_LAB_BIND:-127.0.0.1}"
M1_LAB_API_KEY="${M1_LAB_API_KEY:-}"

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")" || exit 1
. ./profiles.sh

mkdir -p "$M1_LAB_DIR/bin" "$M1_LAB_DIR/models" "$M1_LAB_DIR/logs" "$M1_LAB_DIR/run"
RUN="$M1_LAB_DIR/run"
LOGS="$M1_LAB_DIR/logs"

die() {
	echo "error: $*" >&2
	exit 1
}

file_size() {
	# Segment files vanish while the download is being joined; a missing file counts as 0.
	stat -f %z "$1" 2>/dev/null || echo 0
}

# Start a command that outlives the SSH session. macOS nohup refuses to run without a console
# ("can't detach from console"), so ignore SIGHUP in a subshell and detach all stdio instead.
# The exec keeps the pid, so $! after the call is the command itself.
detach() {
	local log="$1"
	shift
	(
		trap '' HUP
		exec "$@"
	) </dev/null >>"$log" 2>&1 &
}

pid_alive() {
	[ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null
}

pinned_bin() {
	find "$M1_LAB_DIR/bin/llama-$M1_LAB_LLAMA_BUILD" -name llama-server -type f -perm -u+x 2>/dev/null | head -1
}

# The pinned release build is what the toolkit was tested against; a Homebrew build is the fallback.
llama_bin() {
	local b
	b="$(pinned_bin)"
	if [ -n "$b" ] && "$b" --version >/dev/null 2>&1; then
		echo "$b"
	elif command -v llama-server >/dev/null 2>&1; then
		command -v llama-server
	fi
}

llama_version() {
	"$1" --version 2>&1 | grep -m1 '^version'
}

health_code() {
	curl -s -o /dev/null -m 5 -w "%{http_code}" "http://127.0.0.1:$M1_LAB_PORT/health" 2>/dev/null
}

cmd_probe() {
	echo "host=$(scutil --get ComputerName 2>/dev/null || hostname)"
	echo "chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
	echo "arch=$(uname -m)"
	echo "memory_gb=$(($(sysctl -n hw.memsize) / 1073741824))"
	echo "gpu_wired_limit_mb=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo unknown)"
	echo "macos=$(sw_vers -productVersion)"
	echo "free_disk_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')"
	echo "llama_server=$(llama_bin)"
	echo "brew=$(command -v brew || echo none)"
	echo "huggingface=$(curl -s -o /dev/null -m 10 -w "%{http_code}" https://huggingface.co/api/models/Qwen/Qwen3.8-27B)"
	echo "on_ac_power=$(pmset -g batt 2>/dev/null | grep -q "AC Power" && echo yes || echo no)"
}

cmd_install() {
	local have tarball url dest
	have="$(pinned_bin)"
	if [ -n "$have" ] && "$have" --version >/dev/null 2>&1; then
		echo "llama-server ready: $have ($(llama_version "$have"))"
		return 0
	fi
	tarball="llama-$M1_LAB_LLAMA_BUILD-bin-macos-arm64.tar.gz"
	url="https://github.com/ggml-org/llama.cpp/releases/download/$M1_LAB_LLAMA_BUILD/$tarball"
	dest="$M1_LAB_DIR/bin/llama-$M1_LAB_LLAMA_BUILD"
	echo "downloading $url"
	local n=0 ok=0
	while [ "$n" -lt 20 ]; do
		n=$((n + 1))
		# -C - resumes; the speed floor turns a stalled transfer into a retry instead of a hang.
		if curl -fL -sS -C - --connect-timeout 20 --speed-limit 1000 --speed-time 30 \
			-o "$M1_LAB_DIR/bin/$tarball" "$url"; then
			ok=1
			break
		fi
		sleep 2
	done
	if [ "$ok" = 1 ]; then
		rm -rf "$dest"
		mkdir -p "$dest"
		tar -xzf "$M1_LAB_DIR/bin/$tarball" -C "$dest" || echo "extract failed" >&2
		rm -f "$M1_LAB_DIR/bin/$tarball"
		have="$(pinned_bin)"
		if [ -n "$have" ] && "$have" --version >/dev/null 2>&1; then
			echo "llama-server ready: $have ($(llama_version "$have"))"
			return 0
		fi
		echo "release binary does not run on macOS $(sw_vers -productVersion)" >&2
	else
		echo "release download failed" >&2
	fi
	# Fall back to Homebrew, which builds for the host's macOS.
	if ! command -v llama-server >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
		echo "trying brew install llama.cpp"
		brew install llama.cpp >&2 || die "brew install llama.cpp failed"
	fi
	have="$(command -v llama-server || true)"
	[ -n "$have" ] || die "no working llama-server; install Homebrew on the M1 and rerun"
	echo "llama-server ready (fallback): $have ($(llama_version "$have"))"
}

# One byte range of the model, appended until complete. Resumes from whatever is on disk.
fetch_segment() {
	local url="$1" part="$2" first="$3" last="$4"
	local want=$((last - first + 1)) have before idle=0
	while :; do
		have="$(file_size "$part")"
		[ "$have" -eq "$want" ] && return 0
		if [ "$have" -gt "$want" ]; then
			rm -f "$part"
			continue
		fi
		# Only attempts that add nothing count against the budget; a slow link keeps progressing.
		[ "$idle" -gt 40 ] && return 1
		before="$have"
		# A connection under 20 KB/s for 20 s is dropped and reopened: the CDN throttles per
		# connection, and a fresh one is often faster. Resuming makes the restart cheap.
		curl -fL -sS --connect-timeout 20 --speed-limit 20000 --speed-time 20 \
			-r "$((first + have))-$last" "$url" >>"$part" 2>>"$LOGS/pull.log" || sleep 2
		if [ "$(file_size "$part")" -gt "$before" ]; then idle=0; else idle=$((idle + 1)); fi
	done
}

# Background download worker: parallel ranged segments (per-connection CDN throttling is common),
# verified by sha256, survives the SSH session ending.
pull_worker() {
	profile_load "$1" || exit 1
	local dest="$M1_LAB_DIR/models/$PROFILE_FILE"
	local segs="${M1_LAB_SEGMENTS:-16}"
	# Resuming must reuse the byte ranges the existing segment files were started with.
	if [ -f "$dest.segments" ] && ls "$dest".part[0-9]* >/dev/null 2>&1; then
		segs="$(cat "$dest.segments")"
	else
		echo "$segs" >"$dest.segments"
	fi
	local chunk=$(((PROFILE_SIZE + segs - 1) / segs))
	local i first last pids=""
	echo "downloading" >"$RUN/pull.state"
	i=0
	while [ "$i" -lt "$segs" ]; do
		first=$((i * chunk))
		last=$((first + chunk - 1))
		[ "$last" -ge "$PROFILE_SIZE" ] && last=$((PROFILE_SIZE - 1))
		fetch_segment "$PROFILE_URL" "$dest.part$i" "$first" "$last" &
		pids="$pids $!"
		i=$((i + 1))
	done
	local failed=0 p
	for p in $pids; do
		wait "$p" || failed=1
	done
	if [ "$failed" = 1 ]; then
		echo "failed: a segment made no progress in 40 attempts (see $LOGS/pull.log); rerun pull to resume" >"$RUN/pull.state"
		exit 1
	fi
	echo "verifying" >"$RUN/pull.state"
	: >"$dest.part"
	i=0
	while [ "$i" -lt "$segs" ]; do
		# Delete as we go so the join needs one segment of extra disk, not a second copy.
		cat "$dest.part$i" >>"$dest.part" && rm -f "$dest.part$i"
		i=$((i + 1))
	done
	local got
	got="$(shasum -a 256 "$dest.part" | awk '{print $1}')"
	if [ "$got" != "$PROFILE_SHA256" ]; then
		rm -f "$dest.part"
		echo "failed: sha256 mismatch ($got); download removed, rerun pull" >"$RUN/pull.state"
		exit 1
	fi
	mv "$dest.part" "$dest"
	rm -f "$dest.segments"
	echo "done" >"$RUN/pull.state"
}

downloaded_bytes() {
	local total=0 f
	for f in "$1".part[0-9]*; do
		[ -f "$f" ] && total=$((total + $(file_size "$f")))
	done
	echo "$total"
}

cmd_pull() {
	profile_load "$1" || exit 1
	if [ "$(file_size "$M1_LAB_DIR/models/$PROFILE_FILE")" = "$PROFILE_SIZE" ]; then
		echo "$1" >"$RUN/pull.profile"
		echo "done" >"$RUN/pull.state"
		echo "already downloaded: $PROFILE_FILE"
		return 0
	fi
	if pid_alive "$RUN/pull.pid"; then
		echo "download already running for $(cat "$RUN/pull.profile")"
		return 0
	fi
	echo "$1" >"$RUN/pull.profile"
	echo "starting" >"$RUN/pull.state"
	# Through bash, not the file itself: a downloaded copy is not executable.
	detach "$LOGS/pull.log" /bin/bash "$SELF" _pull-worker "$1"
	local pid=$!
	echo "$pid" >"$RUN/pull.pid"
	# Keep the M1 awake for the whole download, even with the lid closed on AC power.
	detach /dev/null caffeinate -i -m -s -w "$pid"
	echo "download started: $PROFILE_FILE ($(awk -v b="$PROFILE_SIZE" 'BEGIN {printf "%.1f", b / 1e9}') GB)"
}

cmd_pull_status() {
	local profile state
	profile="$(cat "$RUN/pull.profile" 2>/dev/null)"
	[ -n "$profile" ] || {
		echo "state=idle"
		return 0
	}
	profile_load "$profile" || exit 1
	state="$(cat "$RUN/pull.state" 2>/dev/null || echo unknown)"
	if [ "$state" = "starting" ] || [ "$state" = "downloading" ] || [ "$state" = "verifying" ]; then
		pid_alive "$RUN/pull.pid" || state="failed: worker died (see $LOGS/pull.log)"
	fi
	local bytes
	bytes="$(downloaded_bytes "$M1_LAB_DIR/models/$PROFILE_FILE")"
	[ "$state" = "done" ] && bytes="$PROFILE_SIZE"
	echo "profile=$profile"
	echo "state=$state"
	echo "bytes=$bytes"
	echo "total=$PROFILE_SIZE"
}

cmd_stop() {
	if pid_alive "$RUN/server.pid"; then
		kill "$(cat "$RUN/server.pid")"
		local i=0
		while pid_alive "$RUN/server.pid" && [ "$i" -lt 30 ]; do
			sleep 1
			i=$((i + 1))
		done
		pid_alive "$RUN/server.pid" && kill -9 "$(cat "$RUN/server.pid")"
		echo "server stopped"
	else
		echo "server not running"
	fi
	rm -f "$RUN/server.pid" "$RUN/active-profile"
}

cmd_start() {
	profile_load "$1" || exit 1
	local model="$M1_LAB_DIR/models/$PROFILE_FILE"
	[ "$(file_size "$model")" = "$PROFILE_SIZE" ] || die "model not downloaded: $PROFILE_FILE (run pull $1)"
	local bin
	bin="$(llama_bin)"
	[ -n "$bin" ] || die "llama-server not installed (run install)"

	if pid_alive "$RUN/server.pid"; then
		if [ "$(cat "$RUN/active-profile" 2>/dev/null)" = "$1" ] && [ "$(health_code)" = "200" ]; then
			echo "already serving $1 on 127.0.0.1:$M1_LAB_PORT"
			return 0
		fi
		cmd_stop
	fi

	if [ "$M1_LAB_BIND" != "127.0.0.1" ] && [ -z "$M1_LAB_API_KEY" ]; then
		die "refusing to listen on $M1_LAB_BIND without M1_LAB_API_KEY"
	fi
	local auth=""
	[ -n "$M1_LAB_API_KEY" ] && auth="--api-key $M1_LAB_API_KEY"
	# Default: bound to loopback, so the only way in is the SSH tunnel from the other Mac.
	# -kvu: one KV pool shared by the slots, so a single session can use the whole context (without
	# it, -c is split evenly across -np slots).
	# --ctx-checkpoints / --checkpoint-min-step: Qwen3.5+ is a hybrid recurrent model, so the prompt
	# cache can only roll back to a saved checkpoint. Dense checkpoints keep each agent turn from
	# re-reading thousands of tokens of history.
	: >"$LOGS/server.log"
	# shellcheck disable=SC2086
	detach "$LOGS/server.log" "$bin" \
		-m "$model" \
		--alias "$PROFILE_ALIAS" \
		--host "$M1_LAB_BIND" --port "$M1_LAB_PORT" $auth \
		-c "$PROFILE_CTX" -np "$M1_LAB_PARALLEL" -kvu \
		-ngl all -fa on --jinja \
		--reasoning-format deepseek \
		--ctx-checkpoints 64 --checkpoint-min-step 256 \
		--cache-ram 8192 \
		--metrics --no-webui \
		$PROFILE_EXTRA_ARGS ${M1_LAB_SERVER_ARGS:-}
	local pid=$!
	echo "$pid" >"$RUN/server.pid"
	echo "$1" >"$RUN/active-profile"
	detach /dev/null caffeinate -i -m -s -w "$pid"

	local i=0 code
	while [ "$i" -lt 300 ]; do
		kill -0 "$pid" 2>/dev/null || {
			tail -30 "$LOGS/server.log" >&2
			rm -f "$RUN/server.pid" "$RUN/active-profile"
			die "llama-server exited during startup"
		}
		code="$(health_code)"
		if [ "$code" = "200" ]; then
			echo "serving $1 ($PROFILE_ALIAS) on $M1_LAB_BIND:$M1_LAB_PORT after ${i}s"
			return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	die "llama-server not healthy after 300s (see $LOGS/server.log)"
}

cmd_status() {
	if pid_alive "$RUN/server.pid"; then
		echo "server=running pid=$(cat "$RUN/server.pid") profile=$(cat "$RUN/active-profile" 2>/dev/null) health=$(health_code)"
	else
		echo "server=stopped"
	fi
	cmd_pull_status | tr '\n' ' '
	echo
}

# Everything in one foreground run, for starting the server by hand in Terminal on the M1.
cmd_up() {
	local profile="$1"
	profile_load "$profile" || exit 1
	echo "== llama.cpp"
	cmd_install
	echo "== model $PROFILE_FILE"
	cmd_pull "$profile"
	local status state bytes total
	while :; do
		status="$(cmd_pull_status)"
		state="$(echo "$status" | sed -n 's/^state=//p')"
		bytes="$(echo "$status" | sed -n 's/^bytes=//p')"
		total="$(echo "$status" | sed -n 's/^total=//p')"
		case "$state" in
		done) break ;;
		failed*) die "download $state" ;;
		esac
		echo "   $state $(awk -v b="$bytes" -v t="$total" 'BEGIN {printf "%.1f / %.1f GB (%d%%)", b / 1e9, t / 1e9, b * 100 / t}')"
		sleep 30
	done
	echo "   downloaded and sha256-verified"
	echo "== server"
	cmd_start "$profile"
	echo
	echo "Ready. Leave this Mac on power; closing Terminal does not stop the server."
	echo "Stop it later with: bash $SELF stop"
}

case "${1:-}" in
up) cmd_up "${2:-$M1_LAB_DEFAULT_PROFILE}" ;;
probe) cmd_probe ;;
install) cmd_install ;;
pull) cmd_pull "${2:-$M1_LAB_DEFAULT_PROFILE}" ;;
_pull-worker) pull_worker "$2" ;;
pull-status) cmd_pull_status ;;
start) cmd_start "${2:-$M1_LAB_DEFAULT_PROFILE}" ;;
stop) cmd_stop ;;
status) cmd_status ;;
logs) tail -n "${2:-60}" "$LOGS/server.log" ;;
*)
	echo "usage: remote.sh up [profile]|probe|install|pull <profile>|pull-status|start <profile>|stop|status|logs [n]" >&2
	exit 2
	;;
esac
