#!/bin/bash
# Drive a llama.cpp server on the lab's M1 Mac (64 GB) and expose it to Prime Agent as the
# `m1-lab` provider. Runs on this Mac; everything on the M1 happens over SSH via remote.sh.
#
#   m1-lab.sh discover                 list Macs reachable over Bonjour / Tailscale / Thunderbolt
#   m1-lab.sh connect <host> [user]    one-time: SSH key + config for the M1 (password dialog once)
#   m1-lab.sh up [profile]             probe, install, download, start, tunnel, register, smoke test
#   m1-lab.sh session [args...]        prime-agent on the M1 model
#   m1-lab.sh status | logs [n] | down
#
# Direct mode, when SSH to the M1 is not allowed (e.g. Remote Login limited to admins):
#   m1-lab.sh direct-setup [profile]   build one server file to run by hand on the M1 (API key baked in)
#   m1-lab.sh direct-link <addr>...    forward 127.0.0.1:18080 to the M1 (cable link-local first)
#
# Lower-level steps: probe, install, pull [profile] [--wait], start [profile], stop, tunnel
# [start|stop|status], provider [profile], smoke, bench. Profiles live in profiles.sh.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
. "$HERE/profiles.sh"

CONF_DIR="${M1_LAB_CONFIG_DIR:-$HOME/.config/m1-lab}"
SSH_CFG="$CONF_DIR/ssh_config"
KEY="$CONF_DIR/id_ed25519"
ALIAS="m1-lab"
LOCAL_PORT="${M1_LAB_LOCAL_PORT:-18080}"
REMOTE_PORT="${M1_LAB_PORT:-8080}"
# Expanded by the remote shell, so it follows the M1 user's home directory.
REMOTE_DIR="${M1_LAB_REMOTE_DIR:-\$HOME/m1-lab}"
BASE_URL="http://127.0.0.1:$LOCAL_PORT"

say() { printf '\033[1m[m1-lab]\033[0m %s\n' "$*"; }
die() {
	printf '\033[31m[m1-lab] error:\033[0m %s\n' "$*" >&2
	exit 1
}

need_connect() {
	[ -f "$SSH_CFG" ] || die "not connected yet: run '$0 connect <host> [user]' (see '$0 discover')"
}

rssh() { ssh -F "$SSH_CFG" "$ALIAS" "$@"; }

API_KEY_FILE="$CONF_DIR/api-key"
DIRECT_TARGETS="$CONF_DIR/direct-targets"
DIRECT_PROFILE="$CONF_DIR/direct-profile"

direct_mode() { [ -f "$DIRECT_TARGETS" ]; }

# The profile being served: from the M1 over SSH, or as recorded by direct-setup.
current_profile() {
	if direct_mode; then
		cat "$DIRECT_PROFILE" 2>/dev/null
	else
		remote status | sed -n 's/.*profile=\([^ ]*\).*/\1/p' | head -1
	fi
}

remote() {
	need_connect
	rssh "M1_LAB_DIR=$REMOTE_DIR M1_LAB_PORT=$REMOTE_PORT ${M1_LAB_REMOTE_ENV:-} bash $REMOTE_DIR/remote.sh $*"
}

cmd_discover() {
	say "Bonjour SSH hosts (Macs with Remote Login on):"
	local tmp
	tmp="$(mktemp)"
	dns-sd -B _ssh._tcp local. >"$tmp" 2>/dev/null &
	local pid=$!
	sleep 4
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	awk '/Add/ {for (i = 7; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : ""); print ""}' "$tmp" |
		sort -u | while read -r name; do
		[ -n "$name" ] && echo "  $name  ->  $(echo "$name" | tr ' ' '-').local"
	done
	rm -f "$tmp"
	if command -v tailscale >/dev/null 2>&1; then
		say "Tailscale peers online:"
		tailscale status 2>/dev/null | awk '$1 ~ /^100\./ && $0 !~ /offline/ {print "  " $2 "  " $1 "  " $4}' || true
	fi
	local tb
	tb="$(ifconfig bridge0 2>/dev/null | awk '/inet / {print $2}')"
	if [ -n "$tb" ]; then
		say "Thunderbolt Bridge is up on this Mac ($tb); the M1 is usually reachable by its .local name over it."
	fi
}

cmd_connect() {
	local host="${1:-}" user="${2:-}" port="${M1_LAB_SSH_PORT:-22}"
	[ -n "$host" ] || die "usage: $0 connect <host> [user]   (host: name.local, IP, or Tailscale name)"
	[ -n "$user" ] || user="$(whoami)"
	mkdir -p "$CONF_DIR"
	chmod 700 "$CONF_DIR"
	if [ ! -f "$KEY" ]; then
		ssh-keygen -q -t ed25519 -N "" -C "m1-lab@$(scutil --get LocalHostName 2>/dev/null || hostname)" -f "$KEY"
		say "created SSH key $KEY"
	fi
	cat >"$SSH_CFG" <<EOF
Host $ALIAS
  HostName $host
  User $user
  Port $port
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $CONF_DIR/known_hosts
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 4
  ControlMaster auto
  ControlPath $HOME/.ssh/cm-m1lab-%C
  ControlPersist 120
EOF
	say "ssh config written for $user@$host:$port"
	if ssh -F "$SSH_CFG" -o BatchMode=yes "$ALIAS" true 2>/dev/null; then
		say "key login works"
		return 0
	fi
	say "installing the SSH key: enter the M1 password for '$user' in the dialog"
	local pub
	pub="$(cat "$KEY.pub")"
	SSH_ASKPASS="$HERE/askpass.sh" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}" \
		ssh -F "$SSH_CFG" -o ControlMaster=no -o PubkeyAuthentication=no \
		-o PreferredAuthentications=keyboard-interactive,password -o NumberOfPasswordPrompts=2 \
		"$ALIAS" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys)" </dev/null ||
		die "password login failed. On the M1: System Settings > General > Sharing > Remote Login must be on, and '$user' must be its account name"
	ssh -F "$SSH_CFG" -o BatchMode=yes "$ALIAS" true || die "key installed but key login still fails"
	say "key login works"
}

cmd_probe() {
	remote probe
}

cmd_push() {
	need_connect
	rssh "mkdir -p $REMOTE_DIR" || die "cannot reach the M1 over SSH (check the link and Remote Login, or rerun connect)"
	# Write to a temp name and rename: a running remote.sh keeps reading its old inode.
	local f
	for f in remote.sh profiles.sh; do
		rssh "cat > $REMOTE_DIR/.$f.tmp && chmod +x $REMOTE_DIR/.$f.tmp && mv $REMOTE_DIR/.$f.tmp $REMOTE_DIR/$f" <"$HERE/$f"
	done
}

cmd_install() {
	cmd_push
	remote install
}

human_gb() { awk -v b="$1" 'BEGIN {printf "%.1f GB", b / 1e9}'; }

cmd_pull() {
	local profile="${1:-$M1_LAB_DEFAULT_PROFILE}" wait="${2:-}"
	profile_load "$profile"
	remote pull "$profile"
	[ "$wait" = "--wait" ] || return 0
	local status state bytes total last_bytes=0 last_t now rate
	last_t="$(date +%s)"
	while :; do
		status="$(remote pull-status)"
		state="$(echo "$status" | sed -n 's/^state=//p')"
		bytes="$(echo "$status" | sed -n 's/^bytes=//p')"
		total="$(echo "$status" | sed -n 's/^total=//p')"
		case "$state" in
		done)
			say "download complete and sha256-verified: $PROFILE_FILE"
			return 0
			;;
		failed*) die "download $state" ;;
		esac
		now="$(date +%s)"
		rate=$(((bytes - last_bytes) / ((now - last_t) > 0 ? (now - last_t) : 1)))
		[ "$last_bytes" = 0 ] && rate=0
		say "$state $(human_gb "$bytes") / $(human_gb "$total") ($((bytes * 100 / total))%) $(awk -v r="$rate" 'BEGIN {printf "%.1f MB/s", r / 1e6}')"
		last_bytes="$bytes"
		last_t="$now"
		sleep "${M1_LAB_POLL_SECONDS:-30}"
	done
}

cmd_start() { remote start "${1:-$M1_LAB_DEFAULT_PROFILE}"; }

cmd_stop() { remote stop; }

TUNNEL_PID="$CONF_DIR/tunnel.pid"

tunnel_alive() { [ -f "$TUNNEL_PID" ] && kill -0 "$(cat "$TUNNEL_PID")" 2>/dev/null; }

cmd_tunnel() {
	direct_mode || need_connect
	case "${1:-start}" in
	start)
		if tunnel_alive; then
			say "tunnel already running (127.0.0.1:$LOCAL_PORT -> M1 127.0.0.1:$REMOTE_PORT)"
		else
			if lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
				die "port $LOCAL_PORT is taken by another process (set M1_LAB_LOCAL_PORT)"
			fi
			if direct_mode; then
				local targets=() t
				while read -r t; do [ -n "$t" ] && targets+=(--target "$t"); done <"$DIRECT_TARGETS"
				(
					trap '' HUP
					exec python3 "$HERE/forward.py" --listen "$LOCAL_PORT" --port "$REMOTE_PORT" "${targets[@]}"
				) >>"$CONF_DIR/tunnel.log" 2>&1 </dev/null &
				echo $! >"$TUNNEL_PID"
				say "forwarder started (127.0.0.1:$LOCAL_PORT -> $(tr '\n' ' ' <"$DIRECT_TARGETS")port $REMOTE_PORT)"
			else
				# Reconnects by itself when the link drops (sleep, cable, Wi-Fi roam). ControlPath=none:
				# through a shared master the forward would live in the mux process and die with it.
				(
					trap '' HUP
					exec bash -c "while :; do ssh -F '$SSH_CFG' -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -N -L 127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT $ALIAS; sleep 3; done"
				) >>"$CONF_DIR/tunnel.log" 2>&1 </dev/null &
				echo $! >"$TUNNEL_PID"
				say "tunnel started (127.0.0.1:$LOCAL_PORT -> M1 127.0.0.1:$REMOTE_PORT)"
			fi
		fi
		if direct_mode; then
			# The M1 server may still be downloading; report instead of waiting.
			say "M1 server health: $(curl -s -m 5 "$BASE_URL/health" || echo 'not answering yet')"
			return 0
		fi
		local i=0
		until curl -s -o /dev/null -m 3 "$BASE_URL/health"; do
			i=$((i + 1))
			[ "$i" -gt 20 ] && die "tunnel is up but $BASE_URL/health does not answer (see $CONF_DIR/tunnel.log)"
			sleep 1
		done
		;;
	stop)
		if tunnel_alive; then
			local pid
			pid="$(cat "$TUNNEL_PID")"
			# Children first: once the loop is gone its ssh is reparented and pkill -P misses it.
			pkill -P "$pid" 2>/dev/null || true
			kill "$pid" 2>/dev/null || true
			say "tunnel stopped"
		fi
		rm -f "$TUNNEL_PID"
		;;
	status)
		if tunnel_alive; then echo "tunnel=running health=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE_URL/health")"; else echo "tunnel=stopped"; fi
		;;
	*) die "usage: $0 tunnel [start|stop|status]" ;;
	esac
}

cmd_provider() {
	local profile="${1:-}"
	[ -n "$profile" ] || profile="$(current_profile)"
	[ -n "$profile" ] || profile="$M1_LAB_DEFAULT_PROFILE"
	profile_load "$profile"
	local key_args=()
	# The key stays in its 0600 file; models.json only holds the command that reads it.
	direct_mode && key_args=(--api-key "!cat '$API_KEY_FILE'")
	node "$HERE/provider.mjs" \
		--base-url "$BASE_URL/v1" --id "$PROFILE_ALIAS" --name "$PROFILE_NAME" \
		--context "$PROFILE_CTX" --max-tokens "$PROFILE_MAX_TOKENS" ${key_args[@]+"${key_args[@]}"}
}

cmd_smoke() {
	local profile
	profile="$(current_profile)"
	[ -n "$profile" ] || die "no model is being served (run '$0 start')"
	profile_load "$profile"
	local failed=0
	M1_LAB_API_KEY="$(cat "$API_KEY_FILE" 2>/dev/null || echo m1-lab-local)" \
		python3 "$HERE/smoke.py" --base-url "$BASE_URL/v1" --model "$PROFILE_ALIAS" || failed=1
	if [ "${M1_LAB_SKIP_AGENT_SMOKE:-}" != 1 ]; then
		say "prime-agent end-to-end (ipython tool call through the harness)"
		node "$REPO/deploy/smoke/json-assert.mjs" --provider m1-lab --model "$PROFILE_ALIAS" --tool --timeout-ms 900000 || failed=1
	fi
	[ "$failed" = 0 ] || die "smoke test failed (details above); the server and tunnel are still up"
}

cmd_bench() {
	python3 "$REPO/deploy/vllm-bench.py" "$BASE_URL" "$@"
}

cmd_status() {
	if direct_mode; then
		say "direct mode: $(tr '\n' ' ' <"$DIRECT_TARGETS")profile=$(current_profile)"
		cmd_tunnel status
		return 0
	fi
	need_connect
	say "$(grep -E '^\s+(HostName|User) ' "$SSH_CFG" | awk '{printf "%s=%s ", $1, $2}')"
	remote status
	cmd_tunnel status
}

cmd_up() {
	local profile="${1:-$M1_LAB_DEFAULT_PROFILE}"
	profile_load "$profile"
	need_connect
	say "1/7 probe"
	local probe mem disk arch
	probe="$(remote probe)"
	echo "$probe" | sed 's/^/    /'
	arch="$(echo "$probe" | sed -n 's/^arch=//p')"
	mem="$(echo "$probe" | sed -n 's/^memory_gb=//p')"
	disk="$(echo "$probe" | sed -n 's/^free_disk_gb=//p')"
	[ "$arch" = "arm64" ] || die "the M1 reports arch=$arch; expected arm64"
	[ "${mem:-0}" -ge 32 ] || die "the M1 reports ${mem} GB RAM; profile $profile needs more"
	local need_gb=$((PROFILE_SIZE / 1000000000 + 3))
	[ "${disk:-0}" -ge "$need_gb" ] || say "WARNING: ${disk} GB free on the M1, download needs ~${need_gb} GB"
	echo "$probe" | grep -q '^huggingface=200' || say "WARNING: the M1 cannot reach huggingface.co right now"

	say "2/7 install llama.cpp ($(echo "${M1_LAB_LLAMA_BUILD:-b11146}"))"
	remote install
	say "3/7 download $PROFILE_FILE ($(human_gb "$PROFILE_SIZE"))"
	cmd_pull "$profile" --wait
	say "4/7 start llama-server"
	cmd_start "$profile"
	say "5/7 tunnel"
	cmd_tunnel start
	say "6/7 register provider m1-lab/$PROFILE_ALIAS"
	cmd_provider "$profile"
	say "7/7 smoke test"
	cmd_smoke
	say "ready. Start a session with:  $0 session    (or: prime-agent --provider m1-lab --model $PROFILE_ALIAS)"
}

cmd_session() {
	local profile
	profile="$(current_profile)"
	[ -n "$profile" ] || die "no model is being served (run '$0 up')"
	profile_load "$profile"
	tunnel_alive || cmd_tunnel start
	# The global default (high -> Qwen's xhigh) means minutes of thinking per turn at M1 decode
	# speeds, so sessions start at medium unless --thinking is given (switch live with /thinking).
	local arg thinking=(--thinking "${M1_LAB_THINKING:-medium}")
	for arg in "$@"; do
		[ "$arg" = "--thinking" ] && thinking=()
	done
	exec prime-agent --provider m1-lab --model "$PROFILE_ALIAS" ${thinking[@]+"${thinking[@]}"} "$@"
}

cmd_down() {
	cmd_tunnel stop
	if direct_mode; then
		say "the server keeps running on the M1; stop it there with: bash ~/Downloads/m1-lab-server.sh stop"
	else
		remote stop
	fi
}

cmd_direct_setup() {
	local profile="${1:-$M1_LAB_DEFAULT_PROFILE}"
	profile_load "$profile"
	mkdir -p "$CONF_DIR"
	chmod 700 "$CONF_DIR"
	if [ ! -s "$API_KEY_FILE" ]; then
		(umask 077 && openssl rand -hex 24 >"$API_KEY_FILE")
	fi
	echo "$profile" >"$DIRECT_PROFILE"
	local out="$CONF_DIR/m1-lab-server.sh" key
	key="$(cat "$API_KEY_FILE")"
	# One self-contained file: remote.sh with profiles.sh inlined, listening on all interfaces
	# (IPv4 + IPv6, so the cable's link-local address works) behind the API key.
	awk -v prof="$HERE/profiles.sh" -v key="$key" -v profile="$profile" '
		/^\. \.\/profiles\.sh$/ { while ((getline line < prof) > 0) print line; next }
		/^M1_LAB_BIND=/ { print "M1_LAB_BIND=\"${M1_LAB_BIND:-::}\""; next }
		/^M1_LAB_API_KEY=/ { print "M1_LAB_API_KEY=\"${M1_LAB_API_KEY:-" key "}\""; next }
		/^M1_LAB_DEFAULT_PROFILE=/ { print "M1_LAB_DEFAULT_PROFILE=\"" profile "\""; next }
		{ print }
	' "$HERE/remote.sh" >"$out"
	chmod 600 "$out"
	bash -n "$out" || die "generated server file does not parse"
	say "server file for the M1: $out"
	say "on the M1, in Terminal:  bash ~/Downloads/m1-lab-server.sh up"
}

cmd_direct_link() {
	[ $# -gt 0 ] || die "usage: $0 direct-link <addr> [addr...]   (e.g. 'fe80::1%en5' then the campus hostname)"
	[ -s "$API_KEY_FILE" ] || die "run '$0 direct-setup' first"
	mkdir -p "$CONF_DIR"
	printf '%s\n' "$@" >"$DIRECT_TARGETS"
	cmd_tunnel stop
	cmd_tunnel start
	cmd_provider
}

sub="${1:-}"
[ $# -gt 0 ] && shift
# Keep the M1's copy of remote.sh/profiles.sh in step with this checkout before any remote command.
if ! direct_mode; then
	case "$sub" in
	probe | pull | start | stop | status | logs | up | down) cmd_push ;;
	esac
fi
case "$sub" in
discover) cmd_discover ;;
connect) cmd_connect "$@" ;;
probe) cmd_probe ;;
install) cmd_install ;;
pull) cmd_pull "$@" ;;
start) cmd_start "$@" ;;
stop) cmd_stop ;;
tunnel) cmd_tunnel "$@" ;;
provider) cmd_provider "$@" ;;
smoke) cmd_smoke ;;
bench) cmd_bench "$@" ;;
status) cmd_status ;;
logs) remote logs "${1:-60}" ;;
up) cmd_up "$@" ;;
session) cmd_session "$@" ;;
down) cmd_down ;;
direct-setup) cmd_direct_setup "$@" ;;
direct-link) cmd_direct_link "$@" ;;
*)
	sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
	[ -z "$sub" ] || exit 2
	;;
esac
