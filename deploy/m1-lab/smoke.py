#!/usr/bin/env python3
"""Endpoint checks for the M1 llama-server, run through the SSH tunnel before handing it to the agent.

  python3 smoke.py --base-url http://127.0.0.1:18080/v1 --model <alias> [--only cache,tools]

Checks the things Prime Agent depends on: streamed tool-call deltas that assemble into valid JSON,
distinct indices for parallel calls, a usage chunk, reasoning split into reasoning_content, thinking
that can be switched off, and prompt-cache reuse across agent turns (a hybrid recurrent model can
only reuse the cache from a saved checkpoint, so this is the check that decides turn latency).
Exit 0 when every required check passes.
"""

import argparse
import json
import os
import sys
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--base-url", default="http://127.0.0.1:18080/v1")
p.add_argument("--model", required=True)
p.add_argument("--only", default="")
p.add_argument("--timeout", type=float, default=900)
a = p.parse_args()

results = []
API_KEY = os.environ.get("M1_LAB_API_KEY", "m1-lab-local")


def post(path, body, stream=False):
    req = urllib.request.Request(
        a.base_url + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
    )
    resp = urllib.request.urlopen(req, timeout=a.timeout)
    if not stream:
        return json.load(resp)
    events = []
    for raw in resp:
        line = raw.decode().strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        events.append(json.loads(data))
    return events


def check(name, ok, detail, required=True):
    results.append((name, ok, required))
    mark = "PASS" if ok else ("FAIL" if required else "WARN")
    print(f"  {mark}  {name}: {detail}")


def wanted(name):
    return not a.only or name in a.only.split(",")


def chat(messages, **extra):
    body = {"model": a.model, "messages": messages, "max_tokens": 2048, "temperature": 0.6}
    body.update(extra)
    return post("/chat/completions", body)


def speed(r):
    t = r.get("timings") or {}
    return (
        f"prefill {t.get('prompt_n', '?')} tok @ {t.get('prompt_per_second', 0):.0f} tok/s, "
        f"decode {t.get('predicted_n', '?')} tok @ {t.get('predicted_per_second', 0):.1f} tok/s"
    )


WEATHER = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}


def assemble_tool_calls(events):
    calls = {}
    for e in events:
        for ch in e.get("choices") or []:
            for tc in (ch.get("delta") or {}).get("tool_calls") or []:
                c = calls.setdefault(tc.get("index", 0), {"id": None, "name": "", "args": ""})
                c["id"] = tc.get("id") or c["id"]
                fn = tc.get("function") or {}
                c["name"] += fn.get("name") or ""
                c["args"] += fn.get("arguments") or ""
    return calls


print(f"m1-lab smoke: {a.model} @ {a.base_url}")

if wanted("models"):
    req = urllib.request.Request(a.base_url + "/models", headers={"Authorization": f"Bearer {API_KEY}"})
    models = json.load(urllib.request.urlopen(req, timeout=30))
    ids = [m["id"] for m in models.get("data", [])]
    check("models", a.model in ids, f"served ids {ids}")

if wanted("basic"):
    t0 = time.time()
    r = chat([{"role": "user", "content": "Reply with exactly the word pong and nothing else."}], reasoning_effort="low",
             max_tokens=6144)
    msg = r["choices"][0]["message"]
    check("basic", "pong" in (msg.get("content") or "").lower(), f"{msg.get('content')!r} in {time.time() - t0:.1f}s; {speed(r)}")
    check("reasoning split", bool(msg.get("reasoning_content")) and "<think>" not in (msg.get("content") or ""),
          f"reasoning_content {len(msg.get('reasoning_content') or '')} chars, no <think> in content")

if wanted("nothink"):
    r = chat([{"role": "user", "content": "Reply with exactly the word pong."}],
             chat_template_kwargs={"enable_thinking": False})
    msg = r["choices"][0]["message"]
    check("thinking off", not msg.get("reasoning_content") and "pong" in (msg.get("content") or "").lower(),
          f"content {msg.get('content')!r}, reasoning {len(msg.get('reasoning_content') or '')} chars")

if wanted("tools"):
    ev = post("/chat/completions", {
        "model": a.model, "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 2048,
        "reasoning_effort": "low", "tools": [WEATHER],
        "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
    }, stream=True)
    calls = assemble_tool_calls(ev)
    ok, detail = False, f"no tool call; calls={calls}"
    if calls:
        c = calls[min(calls)]
        try:
            args = json.loads(c["args"])
            ok = c["name"] == "get_weather" and "paris" in str(args.get("city", "")).lower() and bool(c["id"])
            detail = f"{c['name']}({c['args']}) id={c['id']}"
        except json.JSONDecodeError:
            detail = f"arguments are not JSON: {c['args']!r}"
    check("streamed tool call", ok, detail)
    finish = [ch.get("finish_reason") for e in ev for ch in (e.get("choices") or []) if ch.get("finish_reason")]
    check("finish_reason", finish[-1:] == ["tool_calls"], f"{finish}")
    usage = [e["usage"] for e in ev if e.get("usage")]
    check("usage chunk", bool(usage), f"{usage[-1] if usage else 'none'}")

if wanted("parallel"):
    ev = post("/chat/completions", {
        "model": a.model, "stream": True, "max_tokens": 2048, "reasoning_effort": "low", "tools": [WEATHER],
        "messages": [{"role": "user", "content": "Get the weather for Paris and for Tokyo. Call the tool for both cities in this single turn."}],
    }, stream=True)
    calls = assemble_tool_calls(ev)
    cities = []
    for c in calls.values():
        try:
            cities.append(json.loads(c["args"]).get("city"))
        except json.JSONDecodeError:
            cities.append(f"<bad json {c['args']!r}>")
    ids = {c["id"] for c in calls.values()}
    check("parallel tool calls", len(calls) >= 2 and len(ids) == len(calls), f"{len(calls)} calls {cities}",
          required=False)

if wanted("cache"):
    # An agent-shaped turn pair: long system prompt, a tool round trip, then a follow-up.
    system = "You are a careful assistant.\n" + "\n".join(
        f"Rule {i}: when asked about item {i}, answer with the code K{i * 7 % 1000}." for i in range(900))
    msgs = [{"role": "system", "content": system},
            {"role": "user", "content": "What is the weather in Paris? Use the tool."}]
    r1 = chat(msgs, tools=[WEATHER], reasoning_effort="low")
    m1 = r1["choices"][0]["message"]
    first = (r1.get("timings") or {}).get("prompt_n", 0)
    assistant = {"role": "assistant", "content": m1.get("content") or "", "tool_calls": m1.get("tool_calls")}
    if m1.get("reasoning_content"):
        assistant["reasoning_content"] = m1["reasoning_content"]
    if not m1.get("tool_calls"):
        assistant.pop("tool_calls")
        msgs += [assistant, {"role": "user", "content": "Thanks. Now the code for item 12?"}]
    else:
        msgs += [assistant, {"role": "tool", "tool_call_id": m1["tool_calls"][0]["id"], "content": "18C, clear"},]
    r2 = chat(msgs, tools=[WEATHER], reasoning_effort="low")
    t2 = r2.get("timings") or {}
    second = t2.get("prompt_n", 0)
    cached = t2.get("cache_n")
    detail = f"turn 1 prefilled {first} tok; turn 2 prefilled {second} tok (cache_n={cached}); {speed(r2)}"
    check("prompt cache reuse", 0 < second < max(first * 0.25, 1), detail)

failed = [n for n, ok, req in results if req and not ok]
print(f"m1-lab smoke: {len(results) - len(failed)}/{len(results)} ok" + (f"; failed: {', '.join(failed)}" if failed else ""))
sys.exit(1 if failed else 0)
