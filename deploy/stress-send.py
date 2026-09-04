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


def trigger_deploy(url, tok, timeout=240):
    """POST /api/deploy, tolerating the observer being mid-restart from an earlier phase.

    refresh.sh exits 87 at the END of its run, so /api/health can answer 200 microseconds before
    the process goes away -- checking health first is not enough, the POST itself must retry."""
    wait_for_idle_deploy(url, tok, timeout)
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        code, body = req(f"{url}/api/deploy", tok, "POST", {}, timeout=30)
        last = code
        if code in (200, 202):
            return code
        if code == 409:              # one is already running: that is what we wanted anyway
            wait_for_idle_deploy(url, tok, timeout)
            return 200
        time.sleep(4)
    return last


def started_at(url, tok):
    """serverStartedAt changes on every observer restart -- the only reliable proof one happened."""
    code, h = req(f"{url}/api/health", tok, timeout=20)
    return h.get("serverStartedAt") if code == 200 else None


def wait_for_down_window(url, tok, before, timeout=180):
    """Block until the observer is actually mid-restart, or has already come back on a new boot.

    POST /api/deploy returns while refresh.sh is still running, so sending immediately after it
    hits a fully healthy observer and proves nothing. Returns (observed, reason)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        code, h = req(f"{url}/api/health", tok, timeout=10)
        if code != 200 or h.get("_html"):
            return True, f"observer unreachable (http {code})"
        now = h.get("serverStartedAt")
        if before and now and now != before:
            return True, f"already restarted ({before} -> {now})"
        time.sleep(1)
    return False, "never went down within the timeout"


def wait_for_idle_deploy(url, tok, timeout=240):
    """/api/deploy 409s while one is already running, so phases must not stack them."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        code, h = req(f"{url}/api/health", tok, timeout=20)
        if code == 200 and not (h.get("deploy") or {}).get("running"):
            return True
        time.sleep(4)
    return False


class Report:
    def __init__(self):
        self.fails = []
        self.skips = []

    def check(self, label, ok, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
        if not ok:
            self.fails.append(label)

    def skip(self, label, why=""):
        """A skipped phase is NOT a pass. An earlier version printed SKIP and then
        'ALL PHASES PASSED', which is how the redeploy phase went unrun without anyone noticing."""
        print(f"  SKIP  {label}{(' — ' + why) if why else ''}")
        self.skips.append(label)


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
    # Sending the instant after create races the worker's first turn; the RunPod proxy answers
    # with its own page for a beat even though the observer never restarts (measured). Recovery
    # handles that in the UI; here we just want the steady-state assertion, so settle first.
    time.sleep(5)
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
        rep.skip("notlive phase", "no inactive session available")
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
        rep.skip("redeploy phase", "no session from the live phase")
        return
    before = started_at(url, tok)
    code = trigger_deploy(url, tok)
    rep.check("redeploy accepted", code in (200, 202), f"http {code}")
    # Do not start probing until the restart is genuinely under way, or the first send hits a
    # healthy observer, returns 200 and the phase "passes" without touching the window at all.
    observed, why = wait_for_down_window(url, tok, before)
    rep.check("the restart window was actually observed", observed, why)
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


def phase_recover(url, tok, rep, sid):
    """End-to-end proof: run the client's recovery algorithm across a REAL redeploy and assert the
    message lands exactly once. This is the property that matters — surviving the restart is
    worthless if it costs a duplicated prompt."""
    print("\n== phase: recover (exactly-once across a real redeploy) ==")
    if not sid:
        rep.skip("recover phase", "no session")
        return
    marker = f"STRESS_MARKER_{int(time.time())}"

    def landed():
        code, m = req(f"{url}/api/sessions/{sid}/messages", tok, timeout=30)
        msgs = m if isinstance(m, list) else m.get("messages", [])
        n = 0
        for x in msgs:
            if x.get("role") != "user":
                continue
            c = x.get("content")
            if isinstance(c, list):
                c = "".join(b.get("text", "") for b in c if isinstance(b, dict))
            if str(c or "").strip() == marker:
                n += 1
        return n

    before = started_at(url, tok)
    code = trigger_deploy(url, tok)
    rep.check("redeploy accepted", code in (200, 202), f"http {code}")
    # A fixed 2s sleep used to be enough "sometimes"; it is a race. Wait for the real window.
    observed, why = wait_for_down_window(url, tok, before)
    rep.check("the restart window was actually observed", observed, why)

    # The same decision tree as observer/src/web/lib/send.ts.
    outcome, t0, attempts = None, time.time(), 0
    while time.time() - t0 < 180:
        attempts += 1
        code, body = req(f"{url}/api/sessions/{sid}/prompt", tok, "POST", {"message": marker}, timeout=25)
        if code == 200:
            outcome = "delivered"
            break
        if code == 409 and body.get("code") == "session_not_live":
            req(f"{url}/api/sessions/{sid}/resume", tok, "POST", {}, timeout=60)
            time.sleep(3)
            continue
        if body.get("_html"):          # proxy interstitial: provably undelivered, safe to resend
            time.sleep(3)
            continue
        if code == 0 or code >= 500:   # ambiguous: check before resending
            time.sleep(3)
            if landed():
                outcome = "confirmed"
                break
            continue
        rep.check(f"unexpected status {code}", False, str(body)[:120])
        break

    rep.check("message got through the redeploy", outcome is not None, f"after {attempts} attempts, {int(time.time()-t0)}s")

    # The transcript is not readable the instant a send is accepted: the daemon may still be
    # restarting, and /messages reads what has been persisted. Poll rather than assert early --
    # an earlier version of this check reported 0 copies for a message that was on disk.
    count, t1 = 0, time.time()
    while time.time() - t1 < 120:
        count = landed()
        if count >= 1:
            break
        time.sleep(5)
    rep.check("delivered EXACTLY once (no duplicate)", count == 1, f"found {count} copies of the marker")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--session")
    ap.add_argument("--phases", default="live,notlive,redeploy,recover")
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
    if "recover" in phases:
        phase_recover(a.url, tok, rep, sid)
    if rep.fails:
        print(f"\n{len(rep.fails)} FAILED: {', '.join(rep.fails)}")
    elif rep.skips:
        print(f"\nINCONCLUSIVE — {len(rep.skips)} phase(s) skipped: {', '.join(rep.skips)}")
    else:
        print("\nALL PHASES PASSED")
    # A skip is not a pass: exit non-zero so CI (or a human skimming) cannot mistake it for one.
    sys.exit(1 if (rep.fails or rep.skips) else 0)


if __name__ == "__main__":
    main()
