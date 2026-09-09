#!/usr/bin/env python3
"""Throughput benchmark for the self-hosted model pod.

Measures what the harness actually feels: streamed output tokens per second at the concurrency
levels the RLM subagent fan-out uses. Thinking is ON server-side, so reasoning tokens are counted
as output — that is the honest number, since the user waits for them either way.

  python3 deploy/vllm-bench.py <base-url> [--concurrency 1,4,8] [--max-tokens 600]
"""

import argparse
import json
import statistics
import sys
import threading
import time
import urllib.request

PROMPTS = [
    "Explain what a SYN flood is and how SYN cookies mitigate it.",
    "Describe how TLS certificate pinning works and one operational downside.",
    "What is the difference between a reverse shell and a bind shell?",
    "Explain privilege escalation via a misconfigured setuid binary.",
    "How does DNS cache poisoning work, and what does DNSSEC change?",
    "Explain what makes a hash function suitable for password storage.",
    "What is the purpose of ASLR and how does an info leak defeat it?",
    "Describe how mutual TLS differs from ordinary server-side TLS.",
]


def one(url: str, key: str, model: str, prompt: str, max_tokens: int) -> dict:
    body = json.dumps(
        {
            "model": model,
            "stream": True,
            "max_tokens": max_tokens,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode()
    req = urllib.request.Request(
        f"{url}/v1/chat/completions",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {key}",
            # The RunPod proxy 403s urllib's default User-Agent (same Cloudflare rule that
            # runpod-deploy.py already works around). Without this every request fails auth-looking
            # but never reaches vLLM at all.
            "user-agent": "Mozilla/5.0 prime-agent-eray-bench",
        },
    )
    t0 = time.perf_counter()
    ttft = None
    completion = 0
    reasoning = 0
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            for raw in r:
                line = raw.decode("utf8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload == "[DONE]":
                    break
                try:
                    ev = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if ev.get("usage"):
                    u = ev["usage"]
                    completion = u.get("completion_tokens") or completion
                    det = u.get("completion_tokens_details") or {}
                    reasoning = det.get("reasoning_tokens") or 0
                for ch in ev.get("choices") or []:
                    d = ch.get("delta") or {}
                    # Reasoning streams before content; first token of EITHER is time-to-first.
                    if ttft is None and (d.get("content") or d.get("reasoning") or d.get("reasoning_content")):
                        ttft = time.perf_counter() - t0
    except Exception as e:  # noqa: BLE001 - a failed stream is a datapoint, not a crash
        return {"ok": False, "err": str(e)[:120], "wall": time.perf_counter() - t0}
    wall = time.perf_counter() - t0
    return {
        "ok": True,
        "wall": wall,
        "ttft": ttft or wall,
        "completion": completion,
        "reasoning": reasoning,
        "tps": completion / wall if wall else 0.0,
    }


def run_level(url: str, key: str, model: str, n: int, max_tokens: int) -> dict:
    out: list[dict] = []
    lock = threading.Lock()

    def worker(i: int):
        r = one(url, key, model, PROMPTS[i % len(PROMPTS)], max_tokens)
        with lock:
            out.append(r)

    t0 = time.perf_counter()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0
    ok = [r for r in out if r.get("ok")]
    if not ok:
        return {"n": n, "ok": 0, "fail": len(out), "err": (out[0].get("err") if out else "none")}
    total_completion = sum(r["completion"] for r in ok)
    return {
        "n": n,
        "ok": len(ok),
        "fail": len(out) - len(ok),
        "wall": wall,
        # Per-stream: what one agent feels. Aggregate: what the pod delivers across the fan-out.
        "per_stream_tps": statistics.median(r["tps"] for r in ok),
        "aggregate_tps": total_completion / wall,
        "ttft_p50": statistics.median(r["ttft"] for r in ok),
        "ttft_max": max(r["ttft"] for r in ok),
        "reasoning_share": (sum(r["reasoning"] for r in ok) / total_completion) if total_completion else 0.0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--key", default="")
    ap.add_argument("--model", default="qwen3.8-27b-abliterated")
    ap.add_argument("--concurrency", default="1,4,8")
    ap.add_argument("--max-tokens", type=int, default=600)
    a = ap.parse_args()
    url = a.url.rstrip("/")
    key = a.key or open("deploy/.vllm-token").read().strip()

    print(f"{'conc':>5} {'ok':>4} {'per-stream':>11} {'aggregate':>10} {'ttft p50':>9} {'ttft max':>9} {'think%':>7}")
    print("-" * 62)
    results = []
    for lvl in [int(x) for x in a.concurrency.split(",")]:
        r = run_level(url, key, a.model, lvl, a.max_tokens)
        results.append(r)
        if not r.get("wall"):
            print(f"{r['n']:>5} {r['ok']:>4}  FAILED: {r.get('err')}")
            continue
        print(
            f"{r['n']:>5} {r['ok']:>4} {r['per_stream_tps']:>9.1f}/s {r['aggregate_tps']:>8.1f}/s "
            f"{r['ttft_p50']:>8.2f}s {r['ttft_max']:>8.2f}s {r['reasoning_share'] * 100:>6.0f}%"
        )
    print()
    print(json.dumps(results, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
