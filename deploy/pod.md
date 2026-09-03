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
    PUBLIC_KEY                contents of ~/.ssh/lh-harness-pod.pub (enables sshd for the mirror)
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
| mirror | `deploy/pod-mirror.sh --host <ip> --port <p> ~/Desktop/prime-agent-pod` shows `/workspace` locally |

## Live ids (2026-09-03)

| thing | id |
|---|---|
| network volume `prime-agent-eray-vol` (EU-RO-1, 50 GB) | `y0n17rf3mc` |
| template `prime-agent-eray` (image + registry auth + env) | `mmv355evu2` |
| pod `prime-agent-eray` (cpu3g-4-16, $0.16/h) | `26qbk1ihcmfsmh` → https://26qbk1ihcmfsmh-8790.proxy.runpod.net |
| image | `ghcr.io/erikcik/prime-agent-eray:0.1.0` (= `latest`) |

**How the pod was actually created.** Neither the `runpod` MCP `create-pod` tool nor `runpodctl pod create`
can pick a CPU instance size or (MCP) attach a network volume: both fall back to the smallest flavor and
fail with "Container Disk must be less than or equal to 20/30". The working route is the GraphQL mutation
`deployCpuPod(input: deployCpuPodInput!)` with `instanceId: "cpu3g-4-16"`, `templateId`, `networkVolumeId`,
`volumeMountPath`, `containerDiskInGb`, `ports: "8790/http,22/tcp"`, `containerRegistryAuthId`,
`cloudType: SECURE`, `env: [{key,value}]`, authenticated with `?api_key=` (the `~/.runpod/config.toml`
value is single-quoted — strip the quotes). Script: `deploy/runpod-deploy.py`.

## Results

_(filled in by the stress-test run; see `deploy/stress-test-<date>.md`)_
