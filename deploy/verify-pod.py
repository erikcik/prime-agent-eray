#!/usr/bin/env python3
"""Snapshot / verify a prime-agent pod, so a stop-start or a redeploy onto the same network volume
can be proved identical rather than assumed.

    deploy/verify-pod.py snapshot <out.json> --url <observer> [--host H --port P]
    deploy/verify-pod.py compare  <before.json> <after.json>
    deploy/verify-pod.py live     --url <observer> [--host H --port P]   # checks only, no file

Reads PRIME_OBSERVER_TOKEN from deploy/.env (never printed). Live checks that cost model tokens
(a new session) run only with --deep.
"""
import argparse, json, os, re, subprocess, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_token():
    env = os.path.join(HERE, ".env")
    for line in open(env):
        m = re.match(r'^PRIME_OBSERVER_TOKEN=(.*)$', line.strip())
        if m:
            return m.group(1).strip().strip('"')
    sys.exit("PRIME_OBSERVER_TOKEN not found in deploy/.env")


def req(url, token=None, method="GET", body=None, timeout=60):
    r = urllib.request.Request(url, method=method)
    # RunPod's proxy is behind Cloudflare, which 403s (error 1010) on the default
    # Python-urllib user agent. Present a normal one or every request dies pre-auth.
    r.add_header("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) prime-agent-verify")
    if token:
        r.add_header("authorization", f"Bearer {token}")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        r.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(r, data=data, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def ssh(host, port, cmd, timeout=45):
    key = os.path.expanduser("~/.ssh/lh-harness-pod")
    try:
        out = subprocess.run(
            ["ssh", "-p", str(port), "-i", key, "-o", "IdentitiesOnly=yes",
             "-o", "StrictHostKeyChecking=accept-new", "-o", f"ConnectTimeout=20",
             f"node@{host}", cmd],
            capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip()
    except Exception as e:
        return f"SSH_ERROR: {e}"


def snapshot(url, token, host=None, port=None):
    snap = {"url": url}

    # --- auth must be enforced -------------------------------------------------
    # /api/health is intentionally public (it advertises authRequired), so probe auth
    # against a protected route instead or these checks pass vacuously.
    snap["http_no_token"], _ = req(f"{url}/api/sessions")
    snap["http_bad_token"], _ = req(f"{url}/api/sessions", "definitely-not-the-token")
    snap["http_good_token"], _ = req(f"{url}/api/sessions", token)
    _, health = req(f"{url}/api/health", token)
    snap["daemon_state"] = (health.get("daemon") or {}).get("state")
    snap["harness_version"] = (health.get("version") or {}).get("harness")
    snap["observer_version"] = (health.get("version") or {}).get("observer")

    # --- the session showcase --------------------------------------------------
    code, data = req(f"{url}/api/sessions", token)
    ss = data if isinstance(data, list) else data.get("sessions", [])
    snap["sessions"] = sorted(
        [{"sessionId": s.get("sessionId"), "messageCount": s.get("messageCount"),
          "status": s.get("status"), "model": s.get("model"),
          "cost": round((s.get("tokens") or {}).get("cost") or 0, 4),
          "first": (s.get("firstMessage") or "")[:60]} for s in ss],
        key=lambda x: x["sessionId"] or "")

    # every session's transcript must still be readable
    readable = {}
    for s in snap["sessions"]:
        sid = s["sessionId"]
        c, m = req(f"{url}/api/sessions/{sid}/messages", token)
        msgs = m if isinstance(m, list) else m.get("messages", [])
        readable[sid] = {"http": c, "messages": len(msgs)}
    snap["transcripts"] = readable

    # --- volume state over ssh -------------------------------------------------
    if host and port:
        snap["ssh_hostkey"] = ssh(host, port,
            "ssh-keygen -lf /workspace/state/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'")
        snap["settings"] = ssh(host, port, "cat /workspace/prime/agent/settings.json")
        snap["agent_dir"] = sorted(ssh(host, port, "ls /workspace/prime/agent/").split())
        snap["checkout"] = ssh(host, port, "git -C /workspace/app rev-parse --short HEAD")
        snap["session_files"] = ssh(host, port,
            "ls /workspace/prime/agent/sessions/*.jsonl 2>/dev/null | wc -l")
        # The authoritative integrity check. The observer's messageCount is NOT stable across a
        # restart: a live in-memory session counts custom_message records too, while one reloaded
        # from disk does not, so 111 can legitimately become 108 with nothing lost. Counting
        # type=="message" records on disk compares like with like.
        snap["message_records"] = dict(
            (line.split()[0], int(line.split()[1]))
            for line in ssh(host, port,
                'for f in /workspace/prime/agent/sessions/*.jsonl; do '
                'echo "$(basename $f .jsonl) $(grep -c \'"type":"message"\' $f)"; done').splitlines()
            if len(line.split()) == 2)
        # content checksums prove the bytes survived, not just the filenames
        snap["project_md5"] = dict(
            line.split(None, 1)[::-1] for line in
            ssh(host, port, "md5sum /workspace/project/daimon/*final*.mp4 2>/dev/null").splitlines()
            if line.strip()) if ssh(host, port, "ls /workspace/project/daimon 2>/dev/null | head -1") else {}
        snap["serper_key_in_daemon_env"] = ssh(host, port,
            'tr "\\0" "\\n" < /proc/$(pgrep -f "prime-agent" | head -1)/environ | grep -c "^SERPER_API_KEY=" || true')
        snap["oauth_key_in_daemon_env"] = ssh(host, port,
            'tr "\\0" "\\n" < /proc/$(pgrep -f "prime-agent" | head -1)/environ | grep -c "^ANTHROPIC_OAUTH_TOKEN=" || true')
    return snap


DEEP_PROMPT = ("Do exactly three things, then reply with one line only.\n"
               "1) In ipython compute 6*7.\n"
               "2) Use the websearch skill to search for 'Prime Intellect'.\n"
               "3) Reply with: DEEP_OK <the number> <the title of the first search result>\n"
               "If web search fails, reply DEEP_SEARCH_FAILED <error>.")


def deep_check(url, token, model="claude-opus-5"):
    """Creates a real session: proves OAuth, the kernel and Serper all work end to end."""
    # Agent names must be unique at depth 0 and they live on the volume, so a fixed name is
    # rejected on every run after the first ("... already exists at depth 0 under this parent",
    # surfaced as a 502 from POST /api/sessions). Always stamp it.
    import time as _t
    code, r = req(f"{url}/api/sessions", token, "POST", {
        "cwd": "/workspace/project", "provider": "anthropic", "model": model,
        "name": f"stress-verify-{int(_t.time())}", "prompt": DEEP_PROMPT})
    sid = r.get("activeSessionId")
    if not sid:
        return {"created": False, "http": code, "resp": str(r)[:200]}
    import time
    for _ in range(60):
        time.sleep(6)
        c, m = req(f"{url}/api/sessions/{sid}/messages", token)
        msgs = m if isinstance(m, list) else m.get("messages", [])
        for msg in msgs:
            if msg.get("role") != "assistant":
                continue
            body = msg.get("content")
            if isinstance(body, list):
                body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
            for line in str(body or "").splitlines():
                if "DEEP_OK" in line or "DEEP_SEARCH_FAILED" in line:
                    return {"created": True, "sessionId": sid, "verdict": line.strip()[:200]}
    return {"created": True, "sessionId": sid, "verdict": "TIMEOUT"}


def compare(a, b):
    """Prints a PASS/FAIL table. Exit code 1 if anything regressed."""
    fails = []

    def check(label, ok, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        if not ok:
            fails.append(label)

    print("\n== auth & services ==")
    check("auth rejects no token (401)", b["http_no_token"] == 401, f'got {b["http_no_token"]}')
    check("auth rejects bad token (401)", b["http_bad_token"] == 401, f'got {b["http_bad_token"]}')
    check("auth accepts good token (200)", b["http_good_token"] == 200, f'got {b["http_good_token"]}')
    check("daemon online", b["daemon_state"] == "online", str(b["daemon_state"]))
    check("harness version unchanged", a["harness_version"] == b["harness_version"],
          f'{a["harness_version"]} -> {b["harness_version"]}')

    print("\n== session showcase ==")
    ida = [s["sessionId"] for s in a["sessions"]]
    idb = [s["sessionId"] for s in b["sessions"]]
    check("all prior sessions still listed", set(ida).issubset(set(idb)),
          f'missing {sorted(set(ida) - set(idb))}' if not set(ida).issubset(set(idb)) else f'{len(ida)} -> {len(idb)}')
    for s in a["sessions"]:
        m = next((x for x in b["sessions"] if x["sessionId"] == s["sessionId"]), None)
        if not m:
            continue
        if s["messageCount"] != m["messageCount"]:
            print(f'  NOTE  session {s["sessionId"][:13]} observer messageCount '
                  f'{s["messageCount"]} -> {m["messageCount"]} (expected across a restart; '
                  f'on-disk message records are the real check below)')
        check(f'  session {s["sessionId"][:13]} cost/model', s["cost"] == m["cost"] and s["model"] == m["model"],
              f'{s["cost"]}/{s["model"]} -> {m["cost"]}/{m["model"]}')
    for sid, t in a.get("transcripts", {}).items():
        tb = b.get("transcripts", {}).get(sid)
        check(f'  transcript {sid[:13]} still served', bool(tb) and tb["http"] == 200,
              f'http {tb["http"] if tb else "GONE"}')

    if a.get("message_records") or b.get("message_records"):
        ra, rb = a.get("message_records") or {}, b.get("message_records") or {}
        for sid, n in ra.items():
            check(f'  on-disk message records {sid[:13]}', rb.get(sid) == n,
                  f'{n} -> {rb.get(sid, "GONE")}')

    print("\n== volume state ==")
    for k, label in [("ssh_hostkey", "ssh host key unchanged (no MITM warning)"),
                     ("settings", "settings.json unchanged"),
                     ("checkout", "git checkout unchanged"),
                     ("session_files", "session file count"),
                     ("agent_dir", "agent dir contents")]:
        if k in a and k in b:
            check(label, a[k] == b[k], f'{a[k]} -> {b[k]}' if a[k] != b[k] else "")
    if a.get("project_md5") or b.get("project_md5"):
        check("project file checksums (ad mp4s byte-identical)",
              a.get("project_md5") == b.get("project_md5"),
              f'{len(a.get("project_md5") or {})} -> {len(b.get("project_md5") or {})} files')
    for k, label in [("serper_key_in_daemon_env", "SERPER_API_KEY in daemon env"),
                     ("oauth_key_in_daemon_env", "ANTHROPIC_OAUTH_TOKEN in daemon env")]:
        if k in b:
            check(label, b[k] == "1", f'grep count = {b[k]}')

    print(f"\n{'ALL CHECKS PASSED' if not fails else str(len(fails)) + ' CHECK(S) FAILED: ' + ', '.join(fails)}")
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["snapshot", "compare", "live"])
    ap.add_argument("files", nargs="*")
    ap.add_argument("--url"); ap.add_argument("--host"); ap.add_argument("--port")
    ap.add_argument("--deep", action="store_true", help="also create a real session (costs tokens)")
    args = ap.parse_args()

    if args.mode == "compare":
        a, b = (json.load(open(f)) for f in args.files[:2])
        sys.exit(compare(a, b))

    token = load_token()
    snap = snapshot(args.url, token, args.host, args.port)
    if args.deep:
        snap["deep"] = deep_check(args.url, token)
    text = json.dumps(snap, indent=1)
    if args.mode == "snapshot" and args.files:
        open(args.files[0], "w").write(text)
        print(f"wrote {args.files[0]}")
    print(text[:2500])


if __name__ == "__main__":
    main()
