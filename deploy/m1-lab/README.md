# M1 lab provider: `m1-lab`

Runs a local model on the lab's M1 Mac (64 GB unified memory) with llama.cpp and exposes it to
Prime Agent as the `m1-lab` provider. The harness is unchanged: `m1-lab` is a custom provider in
`~/.prime/agent/models.json`, the same way `nano-gpt` and `local-vllm` are wired.

```
this Mac                                     M1 lab Mac (64 GB)
prime-agent --provider m1-lab                llama-server (pinned llama.cpp b11146)
  models.json baseUrl                         127.0.0.1:8080, loopback only
  http://127.0.0.1:18080/v1  ──SSH tunnel──▶  ~/m1-lab/models/<gguf>
```

Everything on the M1 is done over SSH by `m1-lab.sh`. The M1 needs nothing preinstalled: `remote.sh`
uses only stock macOS tools (bash 3.2, curl, shasum, tar, caffeinate), with no Python and no
Homebrew. Homebrew is used only as a fallback if the release binary will not run.

## Before going to the lab

On the M1 (one time, needs its admin):

1. **System Settings > General > Sharing > Remote Login: on.** Note the account name it shows.
2. Plug it into power. Downloads and the server hold a `caffeinate` assertion, but that only prevents
   sleep on AC power.
3. It needs internet access to `huggingface.co` and `github.com` (the M1 downloads the model itself).

On this Mac: nothing. The `m1-lab` provider appears in `/model` after the first `up` or `provider` run.

## In the lab

Connect the two Macs by any route: the same Wi-Fi/LAN, a Thunderbolt cable (Thunderbolt Bridge), or
Tailscale. Then:

```bash
deploy/m1-lab/m1-lab.sh discover                  # lists .local names, Tailscale peers, Thunderbolt Bridge
deploy/m1-lab/m1-lab.sh connect <m1-name>.local <account>
                                                  # password dialog once, installs an SSH key
deploy/m1-lab/m1-lab.sh up                        # probe, llama.cpp, download + verify, start, tunnel,
                                                  # register provider, smoke test
deploy/m1-lab/m1-lab.sh session                   # prime-agent on the M1 model
```

`up` is idempotent, so rerun it after any interruption. The download is resumable and runs detached
on the M1, so a dropped SSH link does not stop it. `up` then waits and prints progress. When done:
`m1-lab.sh down` stops the tunnel and the server (the model stays on the M1's disk).

Other commands: `status`, `logs [n]`, `pull <profile> [--wait]`, `start <profile>`, `stop`,
`tunnel start|stop|status`, `provider [profile]`, `smoke`, `bench [--concurrency 1,2]`.

## Direct mode (no SSH: Remote Login limited to admins)

University-managed Macs often allow Remote Login for **Administrators only**; a non-admin account is
refused even with the right password or key (`dseditgroup -o checkmember -m "$(whoami)" admin` on the
M1 tells you). Direct mode needs no admin rights:

```bash
deploy/m1-lab/m1-lab.sh direct-setup            # API key + one self-contained server file
# copy ~/.config/m1-lab/m1-lab-server.sh to the M1 (AirDrop/download), then on the M1:
#   bash ~/Downloads/m1-lab-server.sh up        # install, download, verify, start (listens on :: behind the key)
deploy/m1-lab/m1-lab.sh direct-link <m1>.local 'fe80::...%en5' <m1-campus-hostname>
deploy/m1-lab/m1-lab.sh smoke && deploy/m1-lab/m1-lab.sh session
```

`direct-link` runs `forward.py` on this Mac: `127.0.0.1:18080` → the first reachable target, so the
provider URL is unchanged. With a USB-C cable between the Macs, the M1's IPv6 link-local address keeps
the traffic on the cable (the IPv4 169.254 address is often unroutable because Wi-Fi claims that
subnet, and Node URLs cannot carry an IPv6 zone id, hence the forwarder). The key lives in
`~/.config/m1-lab/api-key` (0600); `models.json` holds `!cat <that file>`, not the key.

Measured on the lab M1 (2026-09-28, Qwen3.8-27B Q4_K_XL): prefill ~125 tok/s, decode ~12 tok/s, 9/9
smoke checks and the harness tool call pass, turn-2 cache reuse 21 of 22.5K tokens. The agent's
~12K-token system prompt costs ~95 s once per session; later turns reuse the cache.

## Models (`profiles.sh`)

| profile | file | size | notes |
|---|---|---|---|
| `qwen38-27b` (default) | `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF`, `UD-Q4_K_XL` | 17.4 GB | dense 27B, abliterated |
| `qwen38-27b-mtp` | same repo, `GSQ-RCO-IQ3_S-mtp` | 12.1 GB | adds `--spec-type draft-mtp`; untested, bench it first |
| `qwen36-35b-a3b` | `huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated-MTP-GGUF`, `Q4_K` | 21.7 GB | MoE with 3B active, much faster on M1 |
| `test-4b` | `unsloth/Qwen3.5-4B-GGUF`, `Q4_K_M` | 2.7 GB | same `qwen3_5` architecture; rehearsal only |

Every profile pins size and sha256 from the Hugging Face API; a download that does not verify is
deleted, never served. Switch with `m1-lab.sh up <profile>`. Only the loaded model is listed in
`models.json`, because llama-server answers every request with whatever model it has loaded.

Memory for the default profile: 17.4 GB of weights plus about 8.6 GB of f16 KV cache at 128K context (only
16 of Qwen3.8's 64 layers are full attention). That fits under macOS's default GPU wired limit (~75% of
64 GB), so `sysctl iogpu.wired_limit_mb` needs no change.

Speed expectation for the dense 27B on M1 memory bandwidth (M1 Max 400 GB/s, Ultra 800 GB/s): decode
is bandwidth-bound at roughly 15-20 tok/s (Max). Prefill is the slow part, so prompt-cache reuse
matters (below). Run `m1-lab.sh bench` in the lab for real numbers.

## Choices that are load-bearing

- **SSH tunnel, server on loopback.** The llama-server has no auth and is never exposed on the lab
  network. The provider URL stays `http://127.0.0.1:18080/v1` however the Macs are connected.
  The tunnel runs in a reconnect loop, so a sleep or Wi-Fi roam heals by itself.
- **Segmented download (16 parallel ranges).** Hugging Face's CDN throttles per connection; measured
  from this Mac: 1 connection 85 KB/s, 8 about 650 KB/s, 32 about 1.3 MB/s. Segment byte ranges are
  recorded, so a resume never mixes layouts.
- **Context checkpoints (`--ctx-checkpoints 64 --checkpoint-min-step 256`).** Qwen3.5+ is a hybrid
  recurrent model: llama.cpp can reuse the prompt cache only back to a saved checkpoint, and the
  default spacing (8192 tokens) would re-read up to 8K tokens of history every agent turn. On M1,
  that is tens of seconds per turn.
- **`--reasoning-format deepseek`.** Thinking arrives in `reasoning_content`, which Prime Agent
  records and replays, so the replayed history matches the cached prefix.
- **`-kvu` (one KV pool for all slots).** Without it llama-server splits `-c` evenly across the `-np 2`
  slots, and a session would hit a 64K wall while `/model` advertised 128K. Found in the rehearsal.
- **Thinking levels map onto Qwen3.8's own.** llama-server passes a top-level `reasoning_effort` into
  the chat template (verified with `/apply-template`). Prime Agent levels map to low / medium / xhigh,
  and `off` sends `none`, which renders an empty think block. `m1-lab.sh session` starts at
  `--thinking medium`, because the global default `high` (Qwen's xhigh) costs minutes per turn at M1
  decode speeds. Override with `--thinking` or `M1_LAB_THINKING`.
- **`compat`**: `supportsDeveloperRole: false` (the chat template knows `system` only),
  `maxTokensField: "max_tokens"`, `supportsStrictMode: false`.

## Rehearsal (2026-09-27, before the lab)

The whole flow ran against a stand-in M1: a user-level `sshd` on this Mac (port 2222, key-only), a
separate remote dir, and `test-08b` served with Qwen3.8's chat template (`M1_LAB_SERVER_ARGS=
--chat-template-file ...`). Passed: connect (key path), probe, pinned llama.cpp release install
(with stall/resume), segmented download + sha256, start over SSH, tunnel, auto-reconnect after
killing the tunnel's ssh, provider registration, `smoke.py` (8/9: models, reasoning split, thinking
off, streamed tool call, finish_reason, usage chunk, parallel calls, **cache reuse: turn 2 prefilled
21 of 22.5K tokens**), `json-assert --tool` through the real harness (ipython call, answer `42`,
12K tokens cache-read), `session -p`, `down`. The failed check was the 0.8B model looping in
its thinking, a model-quality limit.

Bugs the rehearsal caught and fixed: macOS `nohup` refuses to run without a console over SSH
(replaced by a SIGHUP-ignoring subshell); the tunnel's forward lived inside the SSH ControlMaster
and would have died with it (`ControlPath=none`); the context split across slots (`-kvu`); stale
remote scripts (pushed before every remote command); downloads that could hang forever (speed floor
+ resume); a segment-count change corrupting a resume (layout recorded).

Not rehearsed: the password-dialog key install (a user-level sshd cannot check passwords), the real
27B's speed and quality, and the `-mtp` profile. The first `up` in the lab covers the first two.

## Files

- `m1-lab.sh`: driver, runs on this Mac.
- `remote.sh`: runs on the M1 (pushed by `m1-lab.sh`, atomically, so a running download is not
  disturbed).
- `profiles.sh`: model pins, shared by both.
- `provider.mjs`: writes the `m1-lab` provider into `models.json`.
- `smoke.py`: endpoint checks (tool-call streaming, parallel calls, usage, thinking on/off, cache reuse).
- `askpass.sh`: macOS password dialog for the one-time key install.

Local state on this Mac: `~/.config/m1-lab/` (SSH key, ssh_config, known_hosts, tunnel pid/log).
Override with `M1_LAB_CONFIG_DIR`. Ports: `M1_LAB_LOCAL_PORT` (18080) and `M1_LAB_PORT` (8080 on the
M1).
