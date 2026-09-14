# RunPod runbook (CPU pod + network volume)

Exact calls used with the `runpod` MCP server (GraphQL key in `~/.runpod/config.toml`). CPU pods
are created through the v1 API by the `create-pod` tool with `computeType: "CPU"`.

## 1. Volume

```
create-network-volume  name=prime-agent-eray-vol  size=50  dataCenterId=EU-RO-1
```
Volume-capable data centers (verified 2026-09-03): EU-RO-1, EU-NL-1, EU-FR-1, CA-MTL-3, CA-MTL-4,
US-IL-1, US-KS-2, US-TX-3, US-WA-1, US-CO-1, US-GA-2, US-MO-2, US-NC-2, US-NE-1, EUR-IS-1, EUR-IS-3,
EUR-IS-4, EUR-IS-5, EUR-NO-1, EUR-NO-2, AP-JP-1. (US-CA-2 advertises storage but refuses creates.)
If a create fails on capacity, try the next DC in the same region; check `list-pods` for orphans after retries.

## 2. Pod

```
create-pod
  name=prime-agent-eray
  imageName=ghcr.io/erikcik/prime-agent-eray:<tag>
  containerRegistryAuthId=cmtgfealr000h6h832efsrbit      # ghcr-erikcik
  computeType=CPU  cpuFlavorIds=[cpu3g]  vcpuCount=4        # 4 vCPU / 16 GB ≈ $0.16/h
  dataCenterIds=[<same DC as the volume>]
  networkVolumeId=<volume id>  volumeMountPath=/workspace
  containerDiskInGb=40                                     # cap for cpu3*: vCPU × 10 GB
  ports=[8790/http, 22/tcp]
  env:
    PRIME_OBSERVER_TOKEN      observer login token
    NANO_GPT_API_KEY          NanoGPT key
    ANTHROPIC_OAUTH_TOKEN     sk-ant-oat01-… from `claude setup-token` (optional)
    DEPLOY_GIT_SSH_KEY        contents of ~/.ssh/prime-agent-eray-deploy (read-only deploy key)
    PUBLIC_KEY                contents of ~/.ssh/prime-agent-pod.pub (enables sshd for the mirror)
```
Never pass `volumeInGb` with `networkVolumeId`. Leave the start command empty (image CMD = `serve`).

## 3. Wait and open

* `get-pod` until `desiredStatus=RUNNING` and `portMappings` is populated (22 → public port).
* `stream-pod-logs` until `[entrypoint] ...` prints the banner and the observer logs `listening`.
  First boot on an empty volume: clone + `npm ci` + `npm run build` + observer build (~3–6 min on 4 vCPU).
* Browser: `https://<POD_ID>-8790.proxy.runpod.net` → paste the token.

## 4. Lifecycle tests (record results below)

| test | what to check |
|---|---|
| stop → start | `/workspace` intact; saved sessions listed; a session resumes; SSH port changed; mirror reconnects |
| terminate → new pod, same volume | identical; ssh host key fingerprint unchanged |
| Refresh (UI-only commit) | UI updates in seconds; a running agent keeps streaming |
| Refresh (packages/ commit) | hook warns about daemon restart; refuses while agents work unless forced |
| binding | `deploy/pod-bind.py --pod <id> --install` mirrors `/workspace` into `~/Desktop/prime-agent-pod`; Ops page shows it live |

## Deploy (current route)

```bash
envjson="$(deploy/env-json.sh)"          # renders deploy/.env -> 0600 json, prints key names only
python3 deploy/runpod-deploy.py deploy "$envjson"
rm -f "$envjson"                          # it holds every pod secret in clear text
python3 deploy/runpod-deploy.py pod <podId>   # status + port mappings (22 -> public port)
```
`runpod-deploy.py` defaults to the live stack below; override any of them per-run with
`RUNPOD_VOLUME`, `RUNPOD_TEMPLATE`, `RUNPOD_IMAGE`, `RUNPOD_INSTANCE`, `RUNPOD_DC`, `RUNPOD_NAME`.

## Live ids (2026-09-09, third deployment — clean slate)

| thing | id |
|---|---|
| network volume `prime-agent-eray-vol` (EU-RO-1, 50 GB) | `7chuik9v2b` (created 2026-09-09; `o6kytzktj0` and everything on it was deleted) |
| template | **none** — deployed templateless, so no pod secret is stored in a RunPod template |
| pod `prime-agent-eray` | see `deploy/.binding.json` / the Ops page; nothing survived the wipe |
| image | `ghcr.io/erikcik/prime-agent-eray:0.1.2` (= `latest`, digest `sha256:8010d870…`) |
| binding | the ONE folder `~/Desktop/prime-agent-pod`, driven by `deploy/pod-bind.py` (launchd, pull-only) |
| mirror ssh key | `~/.ssh/prime-agent-pod` (fresh 2026-09-09; the borrowed `lh-harness-pod` key is no longer used here) |

`deployCpuPod` accepts the full spec without `templateId` (imageName + containerRegistryAuthId +
ports + env + containerDiskInGb), which is preferable: a template would otherwise persist the
observer token, the NanoGPT key, the deploy key and the Anthropic OAuth token in RunPod's account
storage, and would pin a stale image tag.

First boot on the empty volume: 178 s from container start to `observer listening`
(clone 31 s, `npm ci` + harness build + observer build ~3 min). A **redeploy onto an existing volume
is ~42 s** — `ensure_built` finds `node_modules` + both dist trees and skips the build, the settings
seed skips (file present), and the daemon recovers its workers from the session files.

**`stop` is not a reliable way to pause.** On 2026-09-04 a stopped pod refused to start with
`There are not enough free vcpu on the host machine to start this pod` — while a pod is stopped its
host can be filled by other tenants, and the pod is then stranded. Terminate + redeploy against the
same `networkVolumeId` always works (71-82 s) and loses nothing, at the cost of a new pod id and URL.
Treat the volume, not the pod, as the durable thing.

**Changing a pod env var means replacing the pod.** RunPod cannot inject env into a running pod, and
the observer's Redeploy button only runs `refresh.sh` (git pull + rebuild + observer restart) — it
never touches env. Terminate and re-run the deploy against the same `networkVolumeId`: the checkout,
sessions, settings and project files all persist. Stop the mirror first and restart it afterwards
with the new 22/tcp mapping.

`SERPER_API_KEY` powers the harness's bundled `websearch` skill (enabled by default via
`bundledSkills.websearch`). The harness checks the env var **before** the `serper` credential in
`auth.json`, so the key stays off the world-readable volume. Without it the skill still loads and the
agent's search attempts simply fail — verified working on this pod (live Serper results returned).

Image `0.1.2` over `0.1.1`: the entrypoint now seeds `settings.json` on a fresh volume
(`anthropic/claude-opus-5` when an Anthropic token is present — otherwise the harness falls back to
`prime-inference` and 402s), and *appends* the RunPod proxy origin to
`PRIME_OBSERVER_ALLOWED_ORIGINS` instead of only setting it when empty (a leftover
`127.0.0.1:8791` from the compose rehearsal used to shadow it and break the UI's WebSocket).

### Superseded (first deployment — pod and volume deleted 2026-09-03 after the second was verified)

| thing | id | state |
|---|---|---|
| network volume `prime-agent-eray-vol` | `y0n17rf3mc` | deleted (content had been mirrored to `~/Desktop/prime-agent-pod`) |
| pod `prime-agent-eray` | `hzymwdbv6iy7nc` | deleted (first pod `26qbk1ihcmfsmh` crash-looped: deploy key on the volume read back 0666) |
| template `prime-agent-eray` | `mmv355evu2` | **still exists** — pins image 0.1.1 and stores the old observer token, NanoGPT key, deploy key and the retired `lh-harness` pubkey. Deleting it was blocked by a local permission classifier on 2026-09-09; delete it in the RunPod console, or treat those as live secrets. |
| image | `ghcr.io/erikcik/prime-agent-eray:0.1.1` | still in GHCR |

**How the pod was actually created.** Neither the `runpod` MCP `create-pod` tool nor `runpodctl pod create`
can pick a CPU instance size or (MCP) attach a network volume: both fall back to the smallest flavor and
fail with "Container Disk must be less than or equal to 20/30". The working route is the GraphQL mutation
`deployCpuPod(input: deployCpuPodInput!)` with `instanceId: "cpu3g-4-16"`, `templateId`, `networkVolumeId`,
`volumeMountPath`, `containerDiskInGb`, `ports: "8790/http,22/tcp"`, `containerRegistryAuthId`,
`cloudType: SECURE`, `env: [{key,value}]`, authenticated with `?api_key=` (the `~/.runpod/config.toml`
value is single-quoted — strip the quotes). Script: `deploy/runpod-deploy.py`.

## Results

_(filled in by the stress-test run; see `deploy/stress-test-<date>.md`)_
