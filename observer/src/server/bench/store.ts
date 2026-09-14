import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type BenchCandidate,
	type BenchJob,
	type BenchRun,
	type BenchSettings,
	type BenchTask,
	DEFAULT_BENCH_SETTINGS,
	type Experiment,
} from "../../shared/bench.ts";

export function newId(prefix: string): string {
	const d = new Date();
	const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}`;
	return `${prefix}_${stamp}_${randomBytes(3).toString("hex")}`;
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,120}$/;

export function assertSafeId(id: string): string {
	if (!SAFE_ID.test(id) || id.includes("..")) throw Object.assign(new Error(`invalid id: ${id}`), { status: 400 });
	return id;
}

/**
 * Plain-file persistence for the benchmark system under `<dataDir>/bench`. Everything is JSON on
 * disk so a pod volume carries it across restarts and the Mac folder binding mirrors it.
 */
export class BenchStore {
	readonly root: string;
	readonly tasksDir: string;
	readonly candidatesDir: string;
	readonly experimentsDir: string;
	readonly runsDir: string;
	readonly shadowDir: string;
	readonly advisorDir: string;
	private jobs = new Map<string, BenchJob>();
	private listeners = new Set<(kind: string) => void>();

	constructor(dataDir: string) {
		this.root = join(dataDir, "bench");
		this.tasksDir = join(this.root, "tasks");
		this.candidatesDir = join(this.root, "candidates");
		this.experimentsDir = join(this.root, "experiments");
		this.runsDir = join(this.root, "runs");
		this.shadowDir = join(this.root, "shadow");
		this.advisorDir = join(this.root, "advisor");
		for (const d of [this.tasksDir, this.candidatesDir, this.experimentsDir, this.runsDir, this.shadowDir, this.advisorDir]) mkdirSync(d, { recursive: true });
	}

	onChange(listener: (kind: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(kind: string): void {
		for (const l of [...this.listeners]) l(kind);
	}

	// ---- settings ---------------------------------------------------------------------------
	settings(): BenchSettings {
		const saved = readJsonFile<Partial<BenchSettings>>(join(this.root, "settings.json")) ?? {};
		return {
			meta: { ...DEFAULT_BENCH_SETTINGS.meta, ...saved.meta },
			advisor: { ...DEFAULT_BENCH_SETTINGS.advisor, ...saved.advisor },
			recorder: { ...DEFAULT_BENCH_SETTINGS.recorder, ...saved.recorder },
			miner: { ...DEFAULT_BENCH_SETTINGS.miner, ...saved.miner },
			intervention: { ...DEFAULT_BENCH_SETTINGS.intervention, ...saved.intervention },
		};
	}

	saveSettings(patch: Partial<BenchSettings>): BenchSettings {
		const cur = this.settings();
		const next: BenchSettings = {
			meta: { ...cur.meta, ...patch.meta },
			advisor: { ...cur.advisor, ...patch.advisor },
			recorder: { ...cur.recorder, ...patch.recorder },
			miner: { ...cur.miner, ...patch.miner },
			intervention: { ...cur.intervention, ...patch.intervention },
		};
		writeJsonAtomic(join(this.root, "settings.json"), next);
		this.changed("settings");
		return next;
	}

	// ---- tasks ------------------------------------------------------------------------------
	taskDir(id: string): string {
		return join(this.tasksDir, assertSafeId(id));
	}

	snapshotDir(id: string): string {
		return join(this.taskDir(id), "snapshot");
	}

	listTasks(): BenchTask[] {
		return this.listDirs(this.tasksDir)
			.map((id) => readJsonFile<BenchTask>(join(this.tasksDir, id, "task.json")))
			.filter((t): t is BenchTask => !!t)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	getTask(id: string): BenchTask | undefined {
		return readJsonFile<BenchTask>(join(this.taskDir(id), "task.json"));
	}

	saveTask(task: BenchTask): BenchTask {
		writeJsonAtomic(join(this.taskDir(task.id), "task.json"), task);
		this.changed("tasks");
		return task;
	}

	deleteTask(id: string): void {
		rmSync(this.taskDir(id), { recursive: true, force: true });
		this.changed("tasks");
	}

	// ---- candidates -------------------------------------------------------------------------
	listCandidates(): BenchCandidate[] {
		return this.listFiles(this.candidatesDir)
			.map((f) => readJsonFile<BenchCandidate>(join(this.candidatesDir, f)))
			.filter((c): c is BenchCandidate => !!c)
			.sort((a, b) => b.anchorAt.localeCompare(a.anchorAt));
	}

	getCandidate(id: string): BenchCandidate | undefined {
		return readJsonFile<BenchCandidate>(join(this.candidatesDir, `${assertSafeId(id)}.json`));
	}

	saveCandidate(c: BenchCandidate): BenchCandidate {
		writeJsonAtomic(join(this.candidatesDir, `${assertSafeId(c.id)}.json`), c);
		this.changed("candidates");
		return c;
	}

	// ---- experiments ------------------------------------------------------------------------
	listExperiments(): Experiment[] {
		return this.listFiles(this.experimentsDir)
			.map((f) => readJsonFile<Experiment>(join(this.experimentsDir, f)))
			.filter((e): e is Experiment => !!e)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	getExperiment(id: string): Experiment | undefined {
		return readJsonFile<Experiment>(join(this.experimentsDir, `${assertSafeId(id)}.json`));
	}

	saveExperiment(e: Experiment): Experiment {
		writeJsonAtomic(join(this.experimentsDir, `${assertSafeId(e.id)}.json`), e);
		this.changed("experiments");
		return e;
	}

	deleteExperiment(id: string): void {
		rmSync(join(this.experimentsDir, `${assertSafeId(id)}.json`), { force: true });
		this.changed("experiments");
	}

	// ---- runs -------------------------------------------------------------------------------
	runDir(id: string): string {
		return join(this.runsDir, assertSafeId(id));
	}

	listRuns(): BenchRun[] {
		return this.listDirs(this.runsDir)
			.map((id) => readJsonFile<BenchRun>(join(this.runsDir, id, "run.json")))
			.filter((r): r is BenchRun => !!r)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	getRun(id: string): BenchRun | undefined {
		return readJsonFile<BenchRun>(join(this.runDir(id), "run.json"));
	}

	saveRun(run: BenchRun): BenchRun {
		writeJsonAtomic(join(this.runDir(run.id), "run.json"), run);
		this.changed("runs");
		return run;
	}

	// ---- jobs (in memory) -------------------------------------------------------------------
	startJob(kind: BenchJob["kind"], label: string): BenchJob {
		const job: BenchJob = { id: newId("job"), kind, label, status: "running", startedAt: new Date().toISOString() };
		this.jobs.set(job.id, job);
		this.changed("jobs");
		return job;
	}

	finishJob(job: BenchJob, result: { error?: unknown; resultIds?: string[] } = {}): void {
		job.status = result.error ? "error" : "done";
		job.endedAt = new Date().toISOString();
		if (result.error) job.error = result.error instanceof Error ? result.error.message : String(result.error);
		if (result.resultIds) job.resultIds = result.resultIds;
		const done = [...this.jobs.values()].filter((j) => j.status !== "running");
		for (const old of done.slice(0, Math.max(0, done.length - 40))) this.jobs.delete(old.id);
		this.changed("jobs");
	}

	listJobs(): BenchJob[] {
		return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	private listDirs(dir: string): string[] {
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && SAFE_ID.test(d.name))
				.map((d) => d.name);
		} catch {
			return [];
		}
	}

	private listFiles(dir: string): string[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => f.endsWith(".json"));
	}
}
