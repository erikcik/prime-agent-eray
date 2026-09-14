#!/usr/bin/env python3
"""
The one folder binding: mirror the pod's /workspace volume into one folder on this Mac, and tell
the observer about it on a fixed cadence so the web UI can show whether the binding is alive.

    deploy/pod-bind.py --pod <POD_ID> --install     # write + load the launchd job (survives reboot)
    deploy/pod-bind.py --status                     # what the daemon last reported
    deploy/pod-bind.py --once                       # a single pass, in the foreground
    deploy/pod-bind.py --uninstall                  # stop and remove the launchd job

Design notes worth keeping:

* Pull-only, and never `--delete`. The pod writes, this folder follows. Nothing here is pushed up,
  so nothing a local edit or a Finder mishap can do reaches the volume.

* ONE folder, `~/Desktop/prime-agent-pod`, and the config lives in `.binding.json` beside this
  script rather than in flags scattered across shells. Earlier there were two mirror folders from
  two different volumes and no way to tell which was current — that is the failure this replaces.

* The heartbeat runs on its OWN thread, independent of the rsync loop. Coupling them would mean a
  slow pass (a first sync moving gigabytes) looks identical to a dead daemon, because both simply
  stop reporting. Reporting "syncing" throughout is what makes the two distinguishable.

* The ssh endpoint is re-resolved whenever a pass fails. RunPod remaps the public 22/tcp port on
  every pod restart, so a cached host:port is wrong the moment the pod bounces — and that, not a
  broken network, is the most common reason a pass suddenly fails.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / ".binding.json"
DEFAULT_DEST = Path.home() / "Desktop" / "prime-agent-pod"
DEFAULT_REMOTE = "/workspace"
DEFAULT_IDENTITY = Path.home() / ".ssh" / "prime-agent-pod"
LOG_PATH = Path.home() / "Library" / "Logs" / "prime-agent-bind.log"
# launchd's stdout goes to /dev/null and only crashes land here, so log() owns LOG_PATH alone
# and each line appears once rather than twice.
ERR_LOG_PATH = Path.home() / "Library" / "Logs" / "prime-agent-bind.err.log"
LABEL = "com.eray.prime-agent-bind"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"

# Must stay in step with BINDING_HEARTBEAT_SEC / BINDING_STALE_SEC in
# observer/src/server/binding/service.ts: the server calls a binding stale at 120 s.
HEARTBEAT_SEC = 30
SYNC_INTERVAL_SEC = 60
OBSERVER_PORT = 8790

EXCLUDES = [
    ".git/",
    "node_modules/",
    "kernel-venv/",
    "jupyter-venv/",
    # Model weights: ~19.5 GB the GPU pod caches on this same volume. Without this every pass tries
    # to drag them down and the binding looks hung rather than slow.
    "hf/",
    "*.sock",
    ".DS_Store",
    "__pycache__/",
    "state/deploy_key",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def log(msg: str) -> None:
    line = f"{now_iso()} {msg}"
    print(line, flush=True)
    try:
        with LOG_PATH.open("a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------------------------
# config


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n")
    os.chmod(CONFIG_PATH, 0o600)


def observer_token() -> str | None:
    """Read PRIME_OBSERVER_TOKEN out of deploy/.env (0600, gitignored)."""
    env_path = HERE / ".env"
    try:
        for line in env_path.read_text().splitlines():
            m = re.match(r"^PRIME_OBSERVER_TOKEN=(.*)$", line.strip())
            if m:
                return m.group(1).strip().strip("\"'") or None
    except OSError:
        pass
    return os.environ.get("PRIME_OBSERVER_TOKEN")


# ---------------------------------------------------------------------------------------------
# runpod


def _runpod_module():
    """Reuse runpod-deploy.py's GraphQL client; the hyphen in its name rules out a plain import."""
    spec = importlib.util.spec_from_file_location("runpod_deploy", HERE / "runpod-deploy.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load runpod-deploy.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def resolve_ssh(pod_id: str) -> tuple[str, int]:
    """Public ip + mapped port for container port 22. Raises when the pod is not running."""
    mod = _runpod_module()
    data = mod.pod(pod_id)
    pod = (data.get("data") or {}).get("pod")
    if not pod:
        raise RuntimeError(f"pod {pod_id} not found (terminated?): {json.dumps(data)[:300]}")
    runtime = pod.get("runtime") or {}
    for p in runtime.get("ports") or []:
        if p.get("privatePort") == 22 and p.get("isIpPublic"):
            return str(p["ip"]), int(p["publicPort"])
    raise RuntimeError(f"pod {pod_id} exposes no public 22/tcp yet (status {pod.get('desiredStatus')})")


# ---------------------------------------------------------------------------------------------
# the binding itself


class Binding:
    def __init__(self, cfg: dict) -> None:
        self.pod_id: str = cfg["pod"]
        self.dest = Path(cfg.get("dest", str(DEFAULT_DEST))).expanduser()
        self.remote: str = cfg.get("remote", DEFAULT_REMOTE)
        self.identity = Path(cfg.get("identity", str(DEFAULT_IDENTITY))).expanduser()
        self.interval: int = int(cfg.get("interval", SYNC_INTERVAL_SEC))
        self.user: str = cfg.get("user", "node")
        self.observer_url: str = cfg.get("observer") or f"https://{self.pod_id}-{OBSERVER_PORT}.proxy.runpod.net"
        self.token = observer_token()

        self.lock = threading.Lock()
        self.started_at = now_iso()
        self.host: str | None = None
        self.port: int | None = None
        self.activity = "syncing"
        self.last_result: str | None = None
        self.last_sync_at: str | None = None
        self.last_duration_ms: int | None = None
        self.files_transferred: int | None = None
        self.bytes_transferred: int | None = None
        self.local_bytes: int | None = None
        self.local_files: int | None = None
        self.consecutive_failures = 0
        self.error: str | None = None
        self.stop = threading.Event()

    # -- heartbeat ----------------------------------------------------------------------------

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "dest": str(self.dest),
                "remote": self.remote,
                "host": self.host,
                "port": self.port,
                "podId": self.pod_id,
                "activity": self.activity,
                "lastResult": self.last_result,
                "lastSyncAt": self.last_sync_at,
                "lastSyncDurationMs": self.last_duration_ms,
                "filesTransferred": self.files_transferred,
                "bytesTransferred": self.bytes_transferred,
                "localBytes": self.local_bytes,
                "localFiles": self.local_files,
                "consecutiveFailures": self.consecutive_failures,
                "error": self.error,
                "daemonStartedAt": self.started_at,
                "agent": "pod-bind.py/1",
            }

    def send_heartbeat(self) -> bool:
        payload = json.dumps(self.snapshot()).encode()
        req = urllib.request.Request(
            f"{self.observer_url}/api/binding/heartbeat",
            data=payload,
            headers={"content-type": "application/json", "user-agent": "prime-agent-bind/1"},
            method="POST",
        )
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=20):
                return True
        except urllib.error.HTTPError as e:
            log(f"[heartbeat] HTTP {e.code}: {e.read()[:200].decode(errors='replace')}")
        except Exception as e:  # noqa: BLE001 - the observer being down must never kill the sync loop
            log(f"[heartbeat] {type(e).__name__}: {e}")
        return False

    def heartbeat_loop(self) -> None:
        while not self.stop.is_set():
            self.send_heartbeat()
            self.stop.wait(HEARTBEAT_SEC)

    # -- sync ---------------------------------------------------------------------------------

    def ssh_opts(self) -> list[str]:
        return [
            "-p", str(self.port),
            "-i", str(self.identity),
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=20",
            "-o", "ServerAliveCountMax=6",
            "-o", "ConnectTimeout=15",
            "-o", "BatchMode=yes",
        ]

    def ensure_endpoint(self, force: bool = False) -> None:
        if self.host and self.port and not force:
            return
        host, port = resolve_ssh(self.pod_id)
        with self.lock:
            self.host, self.port = host, port
        log(f"[bind] endpoint {self.user}@{host}:{port}{self.remote}")

    def measure_local(self) -> tuple[int, int]:
        total = files = 0
        for root, _dirs, names in os.walk(self.dest):
            for n in names:
                try:
                    total += os.path.getsize(os.path.join(root, n))
                    files += 1
                except OSError:
                    pass
        return total, files

    def sync_once(self) -> bool:
        self.ensure_endpoint()
        self.dest.mkdir(parents=True, exist_ok=True)
        cmd = ["rsync", "--archive", "--compress", "--partial", "--human-readable", "--stats", "--timeout=120"]
        for ex in EXCLUDES:
            cmd += ["--exclude", ex]
        cmd += ["-e", "ssh " + " ".join(self.ssh_opts())]
        cmd += [f"{self.user}@{self.host}:{self.remote}/", f"{self.dest}/"]

        with self.lock:
            self.activity = "syncing"
        started = time.monotonic()
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        duration_ms = int((time.monotonic() - started) * 1000)

        if proc.returncode == 0:
            n_files = _stat_int(proc.stdout, r"Number of (?:regular )?files transferred:\s*([\d,]+)")
            n_bytes = _stat_int(proc.stdout, r"Total transferred file size:\s*([\d,]+)")
            local_bytes, local_files = self.measure_local()
            with self.lock:
                self.activity = "idle"
                self.last_result = "ok"
                self.last_sync_at = now_iso()
                self.last_duration_ms = duration_ms
                self.files_transferred = n_files
                self.bytes_transferred = n_bytes
                self.local_bytes = local_bytes
                self.local_files = local_files
                self.consecutive_failures = 0
                self.error = None
            log(f"[bind] synced in {duration_ms}ms · {n_files} files · {n_bytes} B · local {local_files} files")
            return True

        err = (proc.stderr or proc.stdout or "").strip()[-1000:]
        with self.lock:
            self.activity = "idle"
            self.last_result = "error"
            self.last_sync_at = now_iso()
            self.last_duration_ms = duration_ms
            self.consecutive_failures += 1
            self.error = f"rsync exit {proc.returncode}\n{err}"
        log(f"[bind] rsync failed ({proc.returncode}) x{self.consecutive_failures}: {err[:200]}")
        return False

    def run(self) -> None:
        log(f"[bind] {self.dest}  <-  pod {self.pod_id}:{self.remote}  (pull-only, every {self.interval}s)")
        # The heartbeat starts first and on its own thread, so the UI shows "syncing" throughout a
        # long first pass instead of nothing at all.
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        while not self.stop.is_set():
            try:
                ok = self.sync_once()
                if not ok:
                    # Most likely the pod restarted and the 22/tcp mapping moved. Re-resolve before
                    # the next pass rather than failing against a stale port forever.
                    try:
                        self.ensure_endpoint(force=True)
                    except Exception as e:  # noqa: BLE001
                        log(f"[bind] could not re-resolve the endpoint: {e}")
            except Exception as e:  # noqa: BLE001 - a bad pass must never end the daemon
                with self.lock:
                    self.activity = "idle"
                    self.last_result = "error"
                    self.consecutive_failures += 1
                    self.error = f"{type(e).__name__}: {e}"
                log(f"[bind] pass failed: {type(e).__name__}: {e}")
            self.stop.wait(self.interval)


def _stat_int(text: str, pattern: str) -> int | None:
    m = re.search(pattern, text)
    return int(m.group(1).replace(",", "")) if m else None


# ---------------------------------------------------------------------------------------------
# launchd


PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{python}</string>
    <string>{script}</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>{cwd}</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>{errlog}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
"""


def install(cfg: dict) -> None:
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.write_text(
        PLIST.format(
            label=LABEL,
            python=sys.executable,
            script=str(HERE / "pod-bind.py"),
            cwd=str(HERE.parent),
            errlog=str(ERR_LOG_PATH),
        )
    )
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST_PATH)], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"launchctl bootstrap failed: {r.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    print(f"installed {LABEL}")
    print(f"  folder   {cfg.get('dest', DEFAULT_DEST)}")
    print(f"  pod      {cfg['pod']}")
    print(f"  log      {LOG_PATH}")


def uninstall() -> None:
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    if PLIST_PATH.exists():
        PLIST_PATH.unlink()
    print(f"removed {LABEL}")


def show_status(cfg: dict) -> None:
    uid = os.getuid()
    r = subprocess.run(["launchctl", "print", f"gui/{uid}/{LABEL}"], capture_output=True, text=True)
    loaded = r.returncode == 0
    print(f"launchd job : {'loaded' if loaded else 'not loaded'}")
    print(f"config      : {CONFIG_PATH if CONFIG_PATH.exists() else '(none)'}")
    if cfg:
        print(f"pod         : {cfg.get('pod')}")
        print(f"folder      : {cfg.get('dest', DEFAULT_DEST)}")
    if LOG_PATH.exists():
        tail = LOG_PATH.read_text().splitlines()[-12:]
        print("recent log  :")
        for line in tail:
            print(f"  {line}")


# ---------------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description="Bind ~/Desktop/prime-agent-pod to the pod's /workspace.")
    ap.add_argument("--pod", help="RunPod pod id (stored in .binding.json after the first use)")
    ap.add_argument("--dest", default=None, help=f"local folder (default {DEFAULT_DEST})")
    ap.add_argument("--remote", default=None, help=f"path on the pod (default {DEFAULT_REMOTE})")
    ap.add_argument("--identity", default=None, help=f"ssh key (default {DEFAULT_IDENTITY})")
    ap.add_argument("--interval", type=int, default=None, help=f"seconds between passes (default {SYNC_INTERVAL_SEC})")
    ap.add_argument("--observer", default=None, help="observer base URL (default the pod's proxy URL)")
    ap.add_argument("--once", action="store_true", help="run one pass and exit")
    ap.add_argument("--daemon", action="store_true", help="run the loop in the foreground (used by launchd)")
    ap.add_argument("--install", action="store_true", help="install and start the launchd job")
    ap.add_argument("--uninstall", action="store_true", help="stop and remove the launchd job")
    ap.add_argument("--status", action="store_true", help="show the job and recent log")
    args = ap.parse_args()

    cfg = load_config()
    for key, value in (
        ("pod", args.pod),
        ("dest", args.dest),
        ("remote", args.remote),
        ("identity", args.identity),
        ("interval", args.interval),
        ("observer", args.observer),
    ):
        if value is not None:
            cfg[key] = value
    cfg.setdefault("dest", str(DEFAULT_DEST))
    # The observer lives on the pod, so naming a pod without an explicit --observer must re-derive
    # the URL rather than inherit a stored override. Without this a one-off `--observer http://...`
    # used for a local test silently becomes the permanent target of the installed daemon.
    if args.pod and args.observer is None:
        cfg.pop("observer", None)

    if args.uninstall:
        uninstall()
        return
    if args.status:
        show_status(cfg)
        return
    if not cfg.get("pod"):
        ap.error("no pod configured yet — pass --pod <POD_ID> once and it is remembered")
    save_config(cfg)
    if args.install:
        install(cfg)
        return

    binding = Binding(cfg)
    if not binding.token:
        log("[bind] warning: no PRIME_OBSERVER_TOKEN in deploy/.env — heartbeats will be rejected")
    if args.once:
        ok = binding.sync_once()
        binding.send_heartbeat()
        sys.exit(0 if ok else 1)
    try:
        binding.run()
    except KeyboardInterrupt:
        binding.stop.set()


if __name__ == "__main__":
    main()
