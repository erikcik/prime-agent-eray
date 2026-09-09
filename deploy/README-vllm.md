# Self-hosted model: Qwen3.8-27B abliterated on a RunPod GPU pod

Replaces the per-token NanoGPT provider with a GPU pod you rent by the hour. One button in the
observer Ops page (**local model → Deploy model**) creates the pod, waits for it, and points the
harness at it.

```
observer (CPU pod, always on)  ──HTTP──▶  vLLM (GPU pod, start/stop on demand)
  models.json: local-vllm                  qwen3.8-27b-abliterated
  baseUrl rewritten on deploy              OpenAI-compatible :8000
                     ╲                    ╱
                      ╲   network volume ╱   o6kytzktj0, EU-RO-1, 50 GB
                       ╲  /workspace/hf ╱    19.5 GB of weights, downloaded once
```

## The choices, and why they are not arbitrary

**GPU: RTX PRO 6000 Blackwell, 96 GB.** Not a preference — a consequence. The network volume lives
in `EU-RO-1`, a volume cannot move between datacenters, and a pod can only mount a volume in its own
datacenter. A100, L40S and H100 have **no EU-RO-1 presence at all**. The 96 GB Blackwell parts are
the only thing there, so mounting the existing volume picks the GPU for us.

Stock in EU-RO-1 sits at LOW, so `vllm-pod.py` walks a ladder of four specs (Server/Workstation
edition × SECURE/COMMUNITY) rather than losing a race it did not need to enter. All four are the
same silicon in the same `BLACKWELL_96` pool. It distinguishes `SUPPLY_CONSTRAINT` from a real
error and stops on the latter.

**Weights: `twolven/Qwen3.8-27B-abliterated-AWQ-MTP`, 19.5 GB.** The BF16 original is 55.6 GB
against a 50 GB volume that already holds the app checkout and sessions, so BF16 is not an option
regardless of VRAM. This is the most-downloaded non-GGUF quant and — the reason it was chosen over
the NVFP4 build — it ships the MTP head (`model-mtp.safetensors`), which is what makes speculative
decoding available.

**`--max-num-seqs 16`, and this one bites.** Qwen3.8 is `qwen3_5`: a hybrid of 48 GatedDeltaNet
linear-attention layers and 16 full-attention layers. A GatedDeltaNet layer's recurrent state is
allocated **per sequence slot, not per token** — 48 value heads × 128 × 128 × fp32 × 48 layers is
about **151 MB per slot**. vLLM's default of 256 slots therefore reserves ~38 GB before a single
request arrives, which is the "Mamba state cache OOM" people report on this card. 16 slots costs
2.4 GB and still covers 8 RLM subagents plus the parent plus headroom.

**KV cache.** Only the 16 full-attention layers hold a paged cache: 16 layers × 2 × 4 KV heads ×
256 head_dim = 32 KB/token at `fp8_e4m3`. At 128K context that is ~4.2 GB per sequence, so 8
concurrent long sessions fit comfortably in what is left of 96 GB after weights and state.

## Thinking is always on, by design

Three flags, all load-bearing:

| flag | why |
|---|---|
| `--reasoning-parser qwen3` | **Not optional.** The Qwen3 chat template opens every assistant turn with `<think>`. Without a parser the whole reasoning block lands in `message.content` and the harness renders reasoning as the answer. |
| `--default-chat-template-kwargs '{"enable_thinking": true, "reasoning_effort": "xhigh"}'` | Forces thinking at the server so it does not depend on the client asking. `xhigh` is the model's own maximum. |
| `--tool-call-parser qwen3_coder` | What the vLLM recipe pairs with this model. `hermes` is the wrong parser here and tool calls come back as raw text. |

`models.json` carries `reasoning: true`, and deliberately **no** `thinkingLevelMap` and
`supportsReasoningEffort: false` — that is what stops the harness offering an effort picker. There
is no toggle by construction, not by convention.

> Prior art worth knowing: an earlier project hit the opposite problem on this same model family —
> thinking could not be turned *off*, and unbounded reasoning at ~18 tok/s made sessions look hung
> because the SSE stream kept every timeout from firing. Here we want it on, but the lesson stands:
> **never send this model a small `max_tokens`.** At `xhigh` it will spend whatever budget it is
> given on reasoning before it writes an answer. `models.json` sets `maxTokens: 32768`.

## Measured

`python3 deploy/vllm-bench.py <url>` — streamed output tok/s, reasoning tokens counted as output
because the user waits for them either way.

| concurrency | per stream | aggregate | TTFT p50 |
|---|---|---|---|
| 1 | 83.4 tok/s | 83.4 tok/s | 0.40 s |
| 4 | 66.0 tok/s | 235.5 tok/s | 3.03 s |
| 8 | 69.5 tok/s | 494.9 tok/s | 1.55 s |

Per-stream barely degrades from 4 to 8 concurrent — the hybrid architecture keeps the growing term
small. Cold boot to serving was ~280 s including the 19.5 GB download; a warm start off the cached
volume is ~220 s.

## Gotchas that cost time

* **The RunPod proxy 403s `urllib`'s default User-Agent.** It looks exactly like an auth failure but
  never reaches vLLM. Every script here sends `User-Agent: Mozilla/5.0 …`. Same rule that
  `runpod-deploy.py` already worked around.
* **`dockerArgs` are immutable.** Changing a serve flag means a new pod, not a restart. Cheap, since
  the weights are on the volume.
* **The proxy URL is public.** The server runs with `VLLM_API_KEY` (`deploy/.vllm-token`, gitignored).
  Never deploy this without it.
* **`chmod` is a no-op on RunPod network volumes.** Keep credentials in pod env vars.

## Commands

```bash
# create / inspect / stop / terminate
VLLM_API_KEY="$(cat deploy/.vllm-token)" python3 deploy/vllm-pod.py deploy
python3 deploy/vllm-pod.py status <podId>
python3 deploy/vllm-pod.py stop   <podId>
python3 deploy/vllm-pod.py rm     <podId>

# print the serve args without deploying
python3 deploy/vllm-pod.py args

# throughput, and RLM subagent fan-out against the live pod
python3 deploy/vllm-bench.py https://<podId>-8000.proxy.runpod.net --concurrency 1,4,8
node_modules/.bin/tsx deploy/rlm-local-stress.ts --fanout 4,8
```
