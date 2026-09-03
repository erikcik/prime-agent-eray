# Deploying Prime Agent + Observer to a RunPod CPU pod

This directory packages the upstream Prime Agent harness (untouched under `packages/`) together
with the `observer/` web UI into one container that runs on a RunPod CPU pod with a network
volume for persistent state. Nothing here changes how the RLM harness works.

## What runs where

```
pod (container, uid 1000)                     network volume  /workspace
├── prime-agent --mode daemon  (supervised)    ├── app/          git checkout (Refresh = git pull here)
├── observer  :8790            (supervised,    ├── prime/agent/  sessions, artifacts, models.json, logs
│   exit 87 => restart)                        ├── project/      the agents' cwd
└── sshd :22   (optional, key-only)            └── state/ssh/    host keys (deploy key stays on container disk)
```

* **Image** (`deploy/Dockerfile`): Node 22 + system deps + `uv`, a warmed npm cache and the Python
  kernel venv baked at `/opt/prime-agent/kernel-venv` (container disk — RunPod volumes ignore
  `chmod`, which breaks venvs). The repo source is **not** baked in.
* **First boot** (`deploy/entrypoint.sh serve`): clones `erikcik/prime-agent-eray` onto the volume
  with the read-only deploy key, runs `npm ci && npm run build` and the observer build, installs
  `deploy/models.json` if the agent dir has none, then supervises the daemon and the observer.
* **Refresh button** (`deploy/refresh.sh`): `git pull --ff-only`, installs/builds only what changed,
  then the observer exits 87 and is restarted by `run-observer.sh`. Running agents are only
  interrupted when `packages/**` changed (and even then the hook refuses while agents are
  working unless `REFRESH_FORCE=1`).
* **Secrets** come from pod env vars only (see `.env.example`). Never write `auth.json` on the volume.
* **Mirror** (`deploy/pod-mirror.sh`): rsync-over-ssh pull loop of `/workspace` into
  `~/Desktop/prime-agent-pod` on the Mac. SSH port is remapped by RunPod on every restart.

## Build and push the image

```bash
# from the repo root; pods are amd64
docker buildx build --platform linux/amd64 -f deploy/Dockerfile \
  -t ghcr.io/erikcik/prime-agent-eray:<tag> -t ghcr.io/erikcik/prime-agent-eray:latest --push .
```

GHCR login: `gh auth token | docker login ghcr.io -u erikcik --password-stdin`.
The RunPod registry credential `ghcr-erikcik` (id `cmtgfealr000h6h832efsrbit`) pulls the private image.

## Local rehearsal

```bash
cp deploy/.env.example deploy/.env      # fill tokens; DEPLOY_GIT_SSH_KEY="$(cat ~/.ssh/prime-agent-eray-deploy)"
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build
open http://127.0.0.1:8790              # token = PRIME_OBSERVER_TOKEN
```

Inside the container the provider smoke test is
`docker compose -f deploy/docker-compose.yml exec prime node /workspace/app/deploy/smoke/json-assert.mjs --provider nano-gpt --model abliteration-ai/abliterated-model-large-v2 --tool`.

## RunPod

1. Network volume (≥ 50 GB) in a volume-capable data center (EU-RO-1, EU-NL-1, EUR-IS-1, …).
2. CPU pod in the **same** data center: `cpu3g`, 4 vCPU / 16 GB (~$0.16/h), container disk 40 GB,
   `volumeMountPath /workspace`, ports `8790/http, 22/tcp`, image
   `ghcr.io/erikcik/prime-agent-eray:<tag>` with the GHCR credential, env from `.env.example`
   (`PRIME_OBSERVER_TOKEN`, `NANO_GPT_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `DEPLOY_GIT_SSH_KEY`, `PUBLIC_KEY`).
   Never set `volumeInGb` together with `networkVolumeId`. Leave the start command empty.
3. Open `https://<POD_ID>-8790.proxy.runpod.net`, paste the token. First boot takes a few minutes
   (clone + build); the pod log shows `listening on http://0.0.0.0:8790`.
4. Mirror: `deploy/pod-mirror.sh --host <ip> --port <mapped 22> ~/Desktop/prime-agent-pod`.

Stop the pod when idle; the volume keeps everything (sessions resume after start or after a new
pod on the same volume). See `deploy/pod.md` for the exact create calls and stress-test results.

## Provider: NanoGPT abliterated-model-large-v2

`deploy/models.json` registers `nano-gpt` as an OpenAI-compatible provider
(`https://nano-gpt.com/api/v1`, model `abliteration-ai/abliterated-model-large-v2`, 1M context,
tool calling, `supportsDeveloperRole:false`, cost 5/5 with cache reads at $0.5/M as reconciled
against NanoGPT's usage endpoint). Key: `NANO_GPT_API_KEY` env (pod) or `auth.json` (Mac).

NanoGPT accepts only `low|high|max` for `reasoning_effort` on this model (400 otherwise), so `thinkingLevelMap` maps off/minimal→low, medium→high, xhigh→max. Stress-test results (2026-09-03, Mac, via the daemon): smoke reply 8.5 s; ipython tool round trip
7.5 s; 10 sequential tool calls 47 s, all correct; JSON-mode streaming with 39 text deltas and full
usage/cost; RLM child on the nano model spawned, completed, usage attributed; 3 concurrent sessions
and a 6-request burst all correct; ~200k-token attachment answered in 18.6 s; invalid key surfaces
`401 Invalid session`; cost reconciles to the microdollar with cache reads billed at $0.5/M.
`deploy/smoke/json-assert.mjs` encodes the smoke + tool checks for CI-style runs.
