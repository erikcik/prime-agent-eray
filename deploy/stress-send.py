#!/usr/bin/env python3
"""Stress the "can I still talk to my session?" path across every restart shape.

    deploy/stress-send.py --url <observer> [--session <uuid>] [--phases live,notlive,redeploy]

Each phase prints PASS/FAIL and the exact HTTP status, so a regression names itself instead of
showing up later as "the UI is stuck". Exit code 1 if any phase fails.

Phases
  live      a freshly created session accepts a prompt                       (the happy path)
  notlive   an inactive session refuses with 409 session_not_live, and a
            resume-then-send recovers it                                     (what a pod restart leaves behind)
  redeploy  POST /api/deploy, then hammer prompt across the restart window,
            recording every distinct status until it succeeds again          (the observer-down window)
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "Mozilla/5.0 prime-agent-stress"  # Cloudflare 403s the default python UA


def token():
    for line in open(os.path.join(HERE, ".env")):
        m = re.match(r"^PRIME_OBSERVER_TOKEN=(.*)$", line.strip())
        if m:
            return m.group(1).strip().strip('"')
    sys.exit("PRIME_OBSERVER_TOKEN missing from deploy/.env")


def req(url, tok, method="GET", body=None, timeout=90):
    r = urllib.request.Request(url, method=method)
    r.add_header("user-agent", UA)
    r.add_header("authorization", f"Bearer {tok}")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        r.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(r, data=data, timeout=timeout) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw or "{}")
            except Exception:
                return resp.status, {"_raw": raw[:200]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            # An HTML body here means the RunPod proxy answered, not the observer.
            return e.code, {"_html": "waiting for service" in raw.lower(), "_raw": raw[:120]}
    except Exception as e:
        return 0, {"error": str(e)}


class Report:
    def __init__(self):
        self.fails = []

    def check(self, label, ok, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        if not ok:
            self.fails.append(label)


def phase_live(url, tok, rep):
    """A brand-new session must accept a prompt immediately."""
    print("\n== phase: live ==")
    code, r = req(f"{url}/api/sessions", tok, "POST", {
        "cwd": "/workspace/project", "provider": "anthropic", "model": "claude-opus-5",
        "name": f"stress-send-{int(time.time())}", "prompt": "Reply with exactly: STRESS_OK"})
    sid = r.get("sessionId")
    active = r.get("activeSessionId")
    rep.check("create a session", code == 200 and bool(active), f"http {code}")
    if not sid:
        return None
    code, _ = req(f"{url}/api/sessions/{sid}/prompt", tok, "POST", {"message": "second message"})
    rep.check("send to the live session", code == 200, f"http {code}")
    return sid


def phase_notlive(url, tok, rep, sid):
    """The state a pod restart leaves behind: inactive session, prompt refused."""
    print("\n== phase: notlive ==")
    inactive = None
    code, d = req(f"{url}/api/sessions", tok)
    for s in (d if isinstance(d, list) else d.get("sessions", [])):
        if not s.get("activeSessionId") and s.get("sessionFile") and s.get("status") != "deleted":
            inactive = s["sessionId"]
            break
    if not inactive:
        print("  SKIP  no inactive session available")
        return
    code, body = req(f"{url}/api/sessions/{inactive}/prompt", tok, "POST", {"message": "ping"})
    rep.check("inactive session refuses with 409 session_not_live",
              code == 409 and body.get("code") == "session_not_live", f"http {code} {body.get('code')}")

    # This is the recovery the UI must perform on the operator's behalf.
    code, r = req(f"{url}/api/sessions/{inactive}/resume", tok, "POST", {})
    rep.check("resume brings it back", code == 200 and bool(r.get("activeSessionId")), f"http {code}")
    if code != 200:
        return
    ok = False
    for _ in range(12):  # the worker needs a moment to register as live
        code, _b = req(f"{url}/api/sessions/{inactive}/prompt", tok, "POST", {"message": "ping after resume"})
        if code == 200:
            ok = True
            break
        time.sleep(2)
    rep.check("send succeeds after resume", ok, f"last http {code}")


def phase_redeploy(url, tok, rep, sid):
    """The observer-down window: every send across it must eventually land."""
    print("\n== phase: redeploy ==")
    if not sid:
        print("  SKIP  no session from the live phase")
        return
    code, _ = req(f"{url}/api/deploy", tok, "POST", {})
    rep.check("redeploy accepted", code in (200, 202), f"http {code}")
    seen, delivered, t0 = {}, False, time.time()
    while time.time() - t0 < 180:
        code, body = req(f"{url}/api/sessions/{sid}/prompt", tok, "POST", {"message": "across the restart"}, timeout=20)
        key = f"{code}{'/proxy-html' if body.get('_html') else ''}{'/' + body['code'] if body.get('code') else ''}"
        seen[key] = seen.get(key, 0) + 1
        if code == 200:
            delivered = True
            break
        time.sleep(3)
    print(f"  statuses seen across the window: {seen}")
    rep.check("a send eventually lands after the redeploy", delivered, f"gave up after {int(time.time()-t0)}s")
    rep.check("no status was an unexplained 5xx", not any(k.startswith("5") and "proxy-html" not in k for k in seen),
              str([k for k in seen if k.startswith("5")]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--session")
    ap.add_argument("--phases", default="live,notlive,redeploy")
    a = ap.parse_args()
    tok, rep = token(), Report()
    phases = a.phases.split(",")
    sid = a.session
    if "live" in phases:
        sid = phase_live(a.url, tok, rep) or sid
    if "notlive" in phases:
        phase_notlive(a.url, tok, rep, sid)
    if "redeploy" in phases:
        phase_redeploy(a.url, tok, rep, sid)
    print(f"\n{'ALL PHASES PASSED' if not rep.fails else str(len(rep.fails)) + ' FAILED: ' + ', '.join(rep.fails)}")
    sys.exit(1 if rep.fails else 0)


if __name__ == "__main__":
    main()
