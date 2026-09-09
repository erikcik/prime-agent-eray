#!/usr/bin/env python3
"""RunPod GPU pod lifecycle for the local vLLM model server.

The observer "Deploy model" button shells out to this. It is deliberately the same shape as
runpod-deploy.py (raw GraphQL, key from ~/.runpod/config.toml) so there is one deploy idiom in
this repo, not two.

Why these defaults:
  * RTX PRO 6000 Blackwell (96 GB) is the ONLY GPU type with stock in EU-RO-1, which is where the
    network volume lives. A100/L40S/H100 have no EU-RO-1 presence, so mounting the existing
    volume pins the GPU.
  * The model is AWQ 4-bit + MTP (19.5 GB) rather than BF16 (55.6 GB): the volume is 50 GB and
    already holds the app checkout and sessions.
  * HF_HOME points at the volume so the 19.5 GB download survives a stop/start. Restarting a
    stopped pod is then a ~2 min warm boot instead of a ~15 min cold pull.
  * --max-num-seqs is small ON PURPOSE. Qwen3.5 is a hybrid: 48 of its 64 layers are
    GatedDeltaNet, whose recurrent state is allocated per sequence SLOT, not per token
    (48 value heads x 128 x 128 x fp32 x 48 layers = ~151 MB per slot). vLLM's default of 256
    would reserve ~38 GB of state before a single request arrives; that is the reported
    "Mamba state cache OOM" on this GPU. 16 slots costs ~2.4 GB and still covers 8 RLM
    subagents plus the parent plus headroom.

Usage:
  python3 deploy/vllm-pod.py deploy [<env.json>]   # create the pod (prints id + proxy url)
  python3 deploy/vllm-pod.py status <podId>        # desiredStatus + port mappings
  python3 deploy/vllm-pod.py start  <podId>        # resume a stopped pod (warm: model cached)
  python3 deploy/vllm-pod.py stop   <podId>        # stop billing, keep the pod and volume
  python3 deploy/vllm-pod.py rm     <podId>        # terminate the pod entirely
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

CFG = os.path.expanduser("~/.runpod/config.toml")


def _key() -> str:
    env = os.environ.get("RUNPOD_API_KEY")
    if env:
        return env
    cfg = open(CFG).read()
    m = re.search(r"apikey\s*=\s*['\"]?([^'\"\s]+)['\"]?", cfg)
    if not m:
        raise SystemExit(f"no RunPod api key in {CFG} and RUNPOD_API_KEY unset")
    return m.group(1)


def gql(query: str, variables: dict | None = None) -> dict:
    url = "https://api.runpod.io/graphql?api_key=" + urllib.parse.quote(_key())
    req = urllib.request.Request(
        url,
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"content-type": "application/json", "user-agent": "Mozilla/5.0 prime-agent-eray-vllm"},
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": e.read().decode()[:1200]}


# --------------------------------------------------------------------------------------------
# Serving config. Every flag here is load-bearing; see deploy/README-vllm.md for the rationale
# and the measured effect of each one.
# --------------------------------------------------------------------------------------------
MODEL = os.environ.get("VLLM_MODEL", "twolven/Qwen3.8-27B-abliterated-AWQ-MTP")
SERVED_AS = os.environ.get("VLLM_SERVED_NAME", "qwen3.8-27b-abliterated")
MAX_LEN = os.environ.get("VLLM_MAX_MODEL_LEN", "131072")
MAX_SEQS = os.environ.get("VLLM_MAX_NUM_SEQS", "16")
SPEC_TOKENS = os.environ.get("VLLM_SPEC_TOKENS", "3")
GPU_UTIL = os.environ.get("VLLM_GPU_UTIL", "0.92")


def docker_args() -> str:
    spec = json.dumps({"method": "mtp", "num_speculative_tokens": int(SPEC_TOKENS)})
    return " ".join(
        [
            "--model", MODEL,
            "--served-model-name", SERVED_AS,
            "--host", "0.0.0.0",
            "--port", "8000",
            # 4-bit weights carry the model; the vision tower and attention stay unquantized.
            "--max-model-len", MAX_LEN,
            # See the module docstring: this bounds GatedDeltaNet state, not just batch width.
            "--max-num-seqs", MAX_SEQS,
            "--gpu-memory-utilization", GPU_UTIL,
            # Only 16 of 64 layers are full attention, so FP8 KV halves the one term that grows.
            "--kv-cache-dtype", "fp8_e4m3",
            "--attention-backend", "flashinfer",
            # The AWQ repo ships the MTP head; n=3 is where published sm_120 numbers land.
            "--speculative-config", f"'{spec}'",
            "--enable-prefix-caching",
            "--enable-chunked-prefill",
            # Thinking is ALWAYS ON and is not exposed as a toggle. Two separate flags are needed:
            #
            #   --reasoning-parser qwen3
            #       Not optional. The Qwen3 chat template opens every assistant turn with <think>,
            #       so without a parser the whole reasoning block lands in message.content instead
            #       of the separate `reasoning` field, and the harness renders it as the answer.
            #
            #   --default-chat-template-kwargs
            #       Server-side default so thinking does not depend on the client remembering to
            #       ask. reasoning_effort xhigh is the model's own maximum. The ai-ceo-1 lesson was
            #       that on this model family thinking is hard to turn OFF; here we want it on, so
            #       we set it explicitly at the server rather than relying on that default.
            "--reasoning-parser", "qwen3",
            "--default-chat-template-kwargs", "'" + json.dumps({"enable_thinking": True, "reasoning_effort": "xhigh"}) + "'",
            # Agent traffic is tool-call heavy; without these the harness sees raw text.
            # qwen3_coder, not hermes: it is the parser the vLLM recipe pairs with this model.
            "--tool-call-parser", "qwen3_coder",
            "--enable-auto-tool-choice",
            "--trust-remote-code",
        ]
    )


# EU-RO-1 (where the network volume lives) only ever has the 96 GB Blackwell parts, and their
# stock there sits at LOW most of the time, so a single fixed spec loses a race it did not need to
# enter. Both editions are the same silicon in the same BLACKWELL_96 pool; community is the same
# card at a lower price with a weaker availability guarantee. Try them in order rather than making
# the caller guess which one has capacity this minute.
CANDIDATES = [
    ("NVIDIA RTX PRO 6000 Blackwell Server Edition", "SECURE"),
    ("NVIDIA RTX PRO 6000 Blackwell Server Edition", "COMMUNITY"),
    ("NVIDIA RTX PRO 6000 Blackwell Workstation Edition", "SECURE"),
    ("NVIDIA RTX PRO 6000 Blackwell Workstation Edition", "COMMUNITY"),
]


def _is_supply_error(res: dict) -> bool:
    for e in res.get("errors") or []:
        if (e.get("extensions") or {}).get("code") == "SUPPLY_CONSTRAINT":
            return True
        if "no longer any instances available" in (e.get("message") or ""):
            return True
    return False


def deploy(env_path: str | None = None) -> dict:
    dc = os.environ.get("VLLM_DC", "EU-RO-1")
    volume = os.environ.get("VLLM_VOLUME", "o6kytzktj0")
    name = os.environ.get("VLLM_POD_NAME", "prime-agent-vllm")
    image = os.environ.get("VLLM_IMAGE", "vllm/vllm-openai:nightly")

    # An explicit VLLM_GPU/VLLM_CLOUD pins the spec; otherwise walk the ladder.
    pinned_gpu, pinned_cloud = os.environ.get("VLLM_GPU"), os.environ.get("VLLM_CLOUD")
    candidates = [(pinned_gpu, pinned_cloud or "SECURE")] if pinned_gpu else CANDIDATES

    env = {
        # Cache the weights on the network volume, not the ephemeral container disk.
        "HF_HOME": "/workspace/hf",
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
        "VLLM_API_KEY": os.environ.get("VLLM_API_KEY", ""),
        # sm_120 needs the system CUDA toolkit for flashinfer JIT; the image ships it at 13.0.
        "CUDA_HOME": "/usr/local/cuda-13.0",
        "CUDA_DEVICE_MAX_CONNECTIONS": "8",
        "NCCL_P2P_DISABLE": "1",
    }
    if env_path:
        env.update(json.load(open(env_path)))
    env = {k: v for k, v in env.items() if v != ""}

    attempts = []
    for gpu, cloud in candidates:
        inp = {
            "name": name,
            "imageName": image,
            "gpuTypeId": gpu,
            "gpuCount": 1,
            "cloudType": cloud,
            "dataCenterId": dc,
            "networkVolumeId": volume,
            "volumeMountPath": "/workspace",
            # The vLLM image alone is 9.7 GB; leave room for JIT kernel caches.
            "containerDiskInGb": 60,
            # No minVcpuCount / minMemoryInGb on purpose: pinning them narrows the set of hosts
            # RunPod may place on, which turns a LOW-stock datacenter into a hard SUPPLY_CONSTRAINT.
            # The card's host always carries enough CPU and RAM for a single-GPU vLLM server.
            "ports": "8000/http",
            "dockerArgs": docker_args(),
            "env": [{"key": k, "value": v} for k, v in env.items()],
        }
        res = gql(
            "mutation($input: PodFindAndDeployOnDemandInput!) {"
            " podFindAndDeployOnDemand(input: $input) {"
            " id name desiredStatus costPerHr machineId } }",
            {"input": inp},
        )
        pod_obj = ((res.get("data") or {}).get("podFindAndDeployOnDemand")) or None
        if pod_obj and pod_obj.get("id"):
            res["_placed"] = {"gpu": gpu, "cloud": cloud}
            res["_attempts"] = attempts
            return res
        attempts.append({"gpu": gpu, "cloud": cloud, "supply": _is_supply_error(res), "res": res})
        if not _is_supply_error(res):
            # A non-capacity error (bad image, bad volume, auth) will fail identically on every
            # candidate, so stop rather than burning the ladder on it.
            res["_attempts"] = attempts
            return res
    return {"errors": [{"message": "every candidate is out of capacity in " + dc}], "_attempts": attempts}


def status(pod_id: str) -> dict:
    return gql(
        "query($id: String!) { pod(input:{podId:$id}) {"
        " id name desiredStatus costPerHr lastStatusChange"
        " runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort type } } } }",
        {"id": pod_id},
    )


def start(pod_id: str) -> dict:
    return gql(
        "mutation($id: String!) { podResume(input:{podId:$id, gpuCount:1}) { id desiredStatus costPerHr } }",
        {"id": pod_id},
    )


def stop(pod_id: str) -> dict:
    return gql("mutation($id: String!) { podStop(input:{podId:$id}) { id desiredStatus } }", {"id": pod_id})


def rm(pod_id: str) -> dict:
    return gql("mutation($id: String!) { podTerminate(input:{podId:$id}) }", {"id": pod_id})


def proxy_url(pod_id: str) -> str:
    return f"https://{pod_id}-8000.proxy.runpod.net"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps(gql("{ myself { id clientBalance } }"))[:300])
        raise SystemExit(0)
    cmd = sys.argv[1]
    arg = sys.argv[2] if len(sys.argv) > 2 else None
    if cmd == "deploy":
        r = deploy(arg)
        pid = (((r.get("data") or {}).get("podFindAndDeployOnDemand") or {}) or {}).get("id")
        for a in r.get("_attempts") or []:
            print(f"[skip] {a['gpu']} / {a['cloud']}: {'out of capacity' if a['supply'] else 'error'}")
        if pid:
            placed = r.get("_placed") or {}
            cost = (((r.get("data") or {}).get("podFindAndDeployOnDemand") or {}) or {}).get("costPerHr")
            print(f"[ok]   {placed.get('gpu')} / {placed.get('cloud')}  ${cost}/hr")
            print(f"\npod: {pid}\nurl: {proxy_url(pid)}")
        else:
            print(json.dumps({k: v for k, v in r.items() if k != "_attempts"}, indent=1))
    elif cmd == "status":
        print(json.dumps(status(arg), indent=1))
        if arg:
            print(f"url: {proxy_url(arg)}")
    elif cmd in ("start", "stop", "rm"):
        res = {"start": start, "stop": stop, "rm": rm}[cmd](arg)
        print(json.dumps(res, indent=1))
        # GraphQL answers 200 with an "errors" array, so printing the body and exiting 0 makes a
        # real failure look like success to any caller. The observer's ModelPodService checks the
        # exit code, so a resume that RunPod refused ("not enough free GPUs on the host machine")
        # was silently reported as started. Exit non-zero whenever the payload carries errors.
        if res.get("errors") or res.get("http"):
            msgs = "; ".join(e.get("message", "?") for e in (res.get("errors") or []))
            print(f"\n{cmd} FAILED: {msgs or res.get('http')}")
            raise SystemExit(1)
    elif cmd == "args":
        print(docker_args())
    else:
        raise SystemExit(f"unknown command {cmd!r}")
