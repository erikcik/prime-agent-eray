import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../log.ts";

export interface ModelPodState {
	podId?: string;
	/** Set once the pod has ever reported healthy, so a restart can show "warm" vs "cold". */
	everHealthy?: boolean;
	gpu?: string;
	cloud?: string;
	costPerHr?: number;
	createdAt?: string;
	lastError?: string;
}

export type ModelPodPhase = "absent" | "starting" | "downloading" | "ready" | "stopped" | "error";

export interface ModelPodStatus extends ModelPodState {
	phase: ModelPodPhase;
	url?: string;
	/** vLLM answers /health only once the engine has finished loading weights. */
	healthy: boolean;
	servedModel?: string;
	note?: string;
}

export interface ModelPodOptions {
	repoRoot: string;
	dataDir: string;
	agentDir: string;
	/** Bearer token the pod's vLLM server requires; also written into the harness env. */
	apiKey?: string;
	onLine: (line: string) => void;
}

const SERVED_MODEL = "qwen3.8-27b-abliterated";
const PROVIDER_ID = "local-vllm";

/**
 * Owns the GPU pod that serves the self-hosted model, and the one line of models.json that has to
 * agree with it.
 *
 * The pod is deliberately separate from the prime-agent pod: the harness runs on a cheap CPU pod
 * around the clock, while the GPU is the expensive part and should be stoppable independently. The
 * two share the EU-RO-1 network volume, so the 19.5 GB of weights are downloaded once and a later
 * start is warm.
 */
export class ModelPodService {
	private log = logger("model-pod");
	private state: ModelPodState = {};
	private busy = false;
	private loaded = false;

	constructor(private readonly opts: ModelPodOptions) {}

	private get statePath() {
		return join(this.opts.dataDir, "model-pod.json");
	}

	private get script() {
		return join(this.opts.repoRoot, "deploy", "vllm-pod.py");
	}

	private async load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			this.state = JSON.parse(await readFile(this.statePath, "utf8"));
		} catch {
			this.state = {};
		}
	}

	private async save() {
		await mkdir(this.opts.dataDir, { recursive: true });
		await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
	}

	url(): string | undefined {
		return this.state.podId ? `https://${this.state.podId}-8000.proxy.runpod.net` : undefined;
	}

	/** Runs deploy/vllm-pod.py and returns its stdout, streaming each line to the UI. */
	private run(args: string[]): Promise<{ code: number; out: string }> {
		return new Promise((resolve) => {
			if (!existsSync(this.script)) {
				resolve({ code: 127, out: `vllm-pod.py not found at ${this.script}` });
				return;
			}
			const env = { ...process.env };
			if (this.opts.apiKey) env.VLLM_API_KEY = this.opts.apiKey;
			const child = spawn("python3", [this.script, ...args], { cwd: this.opts.repoRoot, env });
			let out = "";
			const take = (b: Buffer) => {
				const s = b.toString("utf8");
				out += s;
				for (const l of s.split("\n")) if (l.trim()) this.opts.onLine(l);
			};
			child.stdout.on("data", take);
			child.stderr.on("data", take);
			child.on("error", (e) => resolve({ code: 126, out: `${out}\nspawn failed: ${e.message}` }));
			child.on("exit", (c) => resolve({ code: c ?? 1, out }));
		});
	}

	async status(): Promise<ModelPodStatus> {
		await this.load();
		if (!this.state.podId) return { ...this.state, phase: "absent", healthy: false };
		const url = this.url();
		const healthy = await this.probe();
		if (healthy) {
			if (!this.state.everHealthy) {
				this.state.everHealthy = true;
				await this.save();
			}
			return { ...this.state, phase: "ready", url, healthy: true, servedModel: SERVED_MODEL };
		}
		// Not healthy is ambiguous on its own: a cold pod is pulling a 9.7 GB image and 19.5 GB of
		// weights, a warm one is only re-loading from the volume, and a stopped one answers nothing
		// either way. Ask RunPod which it is rather than guessing from the probe.
		const { out } = await this.run(["status", this.state.podId]);
		// A pod terminated outside this service (RunPod console, another session, our own stop)
		// answers with a null pod. Without this the state file keeps a dead id forever and the card
		// reports "starting" for a pod that no longer exists.
		if (/"pod":\s*null/.test(out)) {
			this.state = {};
			await this.save();
			return { phase: "absent", healthy: false };
		}
		const stopped = /"desiredStatus":\s*"EXITED"/.test(out);
		if (stopped) return { ...this.state, phase: "stopped", url, healthy: false };
		return {
			...this.state,
			phase: this.state.everHealthy ? "starting" : "downloading",
			url,
			healthy: false,
			note: this.state.everHealthy
				? "Weights are cached on the volume; the engine is reloading."
				: "First boot: pulling the image and 19.5 GB of weights onto the volume.",
		};
	}

	private async probe(): Promise<boolean> {
		const url = this.url();
		if (!url) return false;
		try {
			const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
			return r.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Create the pod, or resume it if one already exists and is stopped. Returns as soon as RunPod
	 * has accepted it — loading takes minutes, so the UI polls status() rather than blocking here.
	 */
	async deploy(): Promise<ModelPodStatus> {
		await this.load();
		if (this.busy) throw Object.assign(new Error("a model-pod action is already running"), { status: 409, code: "model_pod_busy" });
		this.busy = true;
		try {
			if (this.state.podId) {
				const s = await this.status();
				if (s.phase === "ready" || s.phase === "starting" || s.phase === "downloading") return s;
				this.opts.onLine(`resuming existing pod ${this.state.podId} (weights already on the volume)`);
				const { code, out } = await this.run(["start", this.state.podId]);
				// 409, not 502: the web client maps 502/503/504 to "the observer is restarting", so a
				// pod-side failure reported with those codes tells the user the wrong thing entirely.
				if (code !== 0) throw Object.assign(new Error(`resume failed: ${out.slice(-400)}`), { status: 409, code: "model_pod_resume_failed" });
				return await this.status();
			}
			this.opts.onLine("creating a GPU pod in EU-RO-1 on the existing network volume…");
			const { code, out } = await this.run(["deploy"]);
			const id = /^pod:\s*(\S+)/m.exec(out)?.[1];
			if (code !== 0 || !id) {
				this.state.lastError = out.slice(-600);
				await this.save();
				throw Object.assign(new Error(`deploy failed: ${this.state.lastError}`), { status: 409, code: "model_pod_deploy_failed" });
			}
			const placed = /^\[ok\]\s+(.+?)\s+\/\s+(\w+)\s+\$([\d.]+)\/hr/m.exec(out);
			this.state = {
				podId: id,
				createdAt: new Date().toISOString(),
				gpu: placed?.[1],
				cloud: placed?.[2],
				costPerHr: placed ? Number(placed[3]) : undefined,
			};
			await this.save();
			await this.writeProviderBaseUrl();
			return await this.status();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Terminate rather than stop, which is counter-intuitive but correct here.
	 *
	 * A *stopped* RunPod pod stays pinned to the host machine it was placed on. In a datacenter
	 * that sits at LOW availability — which EU-RO-1 does for the only GPU our volume can reach —
	 * another tenant takes that GPU within minutes and the pod can never restart: RunPod answers
	 * "there are not enough free GPUs on the host machine to start this pod", and no amount of
	 * waiting helps if the GPU model itself has left the datacenter. Observed live on 2026-09-09.
	 *
	 * Terminating gives up nothing, because the 19.5 GB of weights live on the network volume, not
	 * on the pod. A fresh deploy re-pulls only the container image and is just as warm. So the
	 * robust lifecycle is deploy/terminate, not start/stop.
	 */
	async stop(): Promise<ModelPodStatus> {
		await this.load();
		if (!this.state.podId) throw Object.assign(new Error("no model pod to stop"), { status: 404 });
		const { code, out } = await this.run(["rm", this.state.podId]);
		if (code !== 0) throw Object.assign(new Error(`terminate failed: ${out.slice(-400)}`), { status: 409, code: "model_pod_stop_failed" });
		this.opts.onLine(`terminated ${this.state.podId}; weights remain cached on the volume`);
		this.state = {};
		await this.save();
		return await this.status();
	}

	/**
	 * Point the harness at this pod, installing the provider first if the agent dir does not have it.
	 *
	 * Installing matters on a pod, not just locally. The entrypoint copies deploy/models.json into
	 * the agent dir ONLY when none exists, so any volume that predates this feature keeps a
	 * models.json with no `local-vllm` entry — and the model would then be undeployable from the UI
	 * forever, with nothing in the catalog for the harness to resolve. Merging one provider is safe:
	 * it never touches the user's other providers or their stored auth.
	 */
	async writeProviderBaseUrl(): Promise<void> {
		const url = this.url();
		if (!url) return;
		const path = join(this.opts.agentDir, "models.json");
		type Doc = { providers?: Record<string, { baseUrl?: string }> };
		let doc: Doc = {};
		try {
			doc = JSON.parse(await readFile(path, "utf8")) as Doc;
		} catch {
			this.log.warn(`no readable models.json at ${path}; creating one`);
		}
		doc.providers ??= {};
		if (!doc.providers[PROVIDER_ID]) {
			// Take the canonical definition from the repo rather than duplicating it here, so the
			// model id, context window and the reasoning flags have exactly one source of truth.
			try {
				const repo = JSON.parse(await readFile(join(this.opts.repoRoot, "deploy", "models.json"), "utf8")) as Doc;
				const seed = repo.providers?.[PROVIDER_ID];
				if (!seed) throw new Error(`deploy/models.json has no "${PROVIDER_ID}" provider`);
				doc.providers[PROVIDER_ID] = seed;
				this.opts.onLine(`models.json: installed the "${PROVIDER_ID}" provider (was missing on this volume)`);
			} catch (e) {
				this.log.warn(`could not seed "${PROVIDER_ID}" into models.json: ${(e as Error).message}`);
				return;
			}
		}
		const p = doc.providers[PROVIDER_ID];
		if (!p) return;
		p.baseUrl = `${url}/v1`;
		await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
		this.opts.onLine(`models.json: ${PROVIDER_ID}.baseUrl -> ${p.baseUrl}`);
	}
}
