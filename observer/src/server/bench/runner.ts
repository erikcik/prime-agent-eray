import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Arm, BenchRun, BenchSettings, BenchTask, Experiment, JudgeVerdict, RunEnvironment, TimelineEntry, Trial, Variant } from "../../shared/bench.ts";
import type { AgentPaths } from "../disk/paths.ts";
import { parseSessionFile } from "../disk/sessions-reader.ts";
import { logger } from "../log.ts";
import { SNAPSHOT_FILES } from "./capture.ts";
import { parseClaudeStream } from "./cc-transcript.ts";
import type { MetaAgent } from "./meta-agent.ts";
import { benchSocketPath, helperEnv, type ProcHandle, runProcess, shutdownDaemonAt } from "./proc.ts";
import type { WorkspaceRecorder } from "./recorder.ts";
import { currentBranch, renderTranscript, toTimeline } from "./snapshot.ts";
import { type BenchStore, newId, readJsonFile, writeJsonAtomic } from "./store.ts";

const log = logger("bench-runner");

export interface RunnerOptions {
	store: BenchStore;
	recorder: WorkspaceRecorder;
	meta: MetaAgent;
	paths: AgentPaths;
	settings: () => BenchSettings;
	primeAgentBin: string;
	repoRoot: string;
	harnessVersion: string;
	env?: NodeJS.ProcessEnv;
}

interface ActiveRun {
	run: BenchRun;
	procs: Set<ProcHandle>;
	cancelled: boolean;
}

interface ArmOutcome {
	rows: TimelineEntry[];
	exitCode: number | null;
	timedOut: boolean;
	stderrTail: string;
	costUsd?: number;
	tokens?: Trial["tokens"];
	sessionFile?: string;
	/** Nothing usable came out (process failed to start, auth error before any turn). */
	empty: boolean;
}

const LAG_WARN_SECONDS = 15 * 60;

/** How a skill variant is framed when inserted, identical across harnesses so only the harness varies. */
export function skillBlock(variant: Variant): string {
	return `<benchmark-skill name="${variant.id}">\nThe following skill applies to the task you are about to work on. Follow it.\n\n${variant.skill.trim()}\n</benchmark-skill>`;
}

const CC_PREAMBLE = `# Context carried over from an earlier session
The conversation below happened in a different agent harness (prime-agent, whose only tool was a persistent Python REPL). You are continuing the same work in this environment, with your own tools, in the same workspace. Treat the transcript as your own history.`;

const JUDGE_SYSTEM = `You judge one trial of a checkpoint benchmark for agent harnesses.

An agent was restarted from a frozen moment of a real session and given a prompt. You decide whether it reached the desired final state. Your working directory is the trial's final workspace: use Read, Grep and Glob to inspect the files the agent produced instead of trusting its claims.

Rules:
- Default to NOT MET. A criterion is met only with concrete evidence: a quoted transcript line, or a file you opened (give its path).
- The operator's desired trajectory, when present, is the expert standard. Judge against it, not against what a typical agent would do.
- Claims without artifacts do not count. A plan is not a delivery.
- score is overall quality in [0,1]. passed=true only if every required criterion is met and the outcome reaches the desired final state.
- Keep evidence short and specific.`;

const JUDGE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		passed: { type: "boolean" },
		score: { type: "number" },
		summary: { type: "string" },
		criteria: {
			type: "array",
			items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } }, required: ["id", "met", "evidence"] },
		},
	},
	required: ["passed", "score", "summary", "criteria"],
};

export class BenchRunner {
	private active = new Map<string, ActiveRun>();

	constructor(private readonly o: RunnerOptions) {}

	isActive(experimentId: string): boolean {
		return [...this.active.values()].some((a) => a.run.experimentId === experimentId);
	}

	activeRunIds(): string[] {
		return [...this.active.keys()];
	}

	/** Trials interrupted by an observer restart cannot be resumed faithfully; say so instead of pretending. */
	recoverOnBoot(): void {
		for (const run of this.o.store.listRuns()) {
			if (run.status !== "running") continue;
			for (const t of run.trials) {
				if (t.status === "preparing" || t.status === "running" || t.status === "judging") {
					t.status = "error";
					t.error = "observer restarted during the trial";
					t.endedAt = new Date().toISOString();
				} else if (t.status === "queued") {
					t.status = "cancelled";
				}
			}
			run.status = "cancelled";
			run.endedAt = new Date().toISOString();
			this.o.store.saveRun(run);
		}
	}

	async start(exp: Experiment, trigger: BenchRun["trigger"], only?: { taskIds?: string[]; armIds?: string[]; repeats?: number }): Promise<BenchRun> {
		if (this.isActive(exp.id)) throw Object.assign(new Error("this experiment already has a run in progress"), { status: 409 });
		const taskIds = only?.taskIds ?? exp.taskIds;
		const arms = exp.arms.filter((a) => !only?.armIds || only.armIds.includes(a.id));
		if (taskIds.length === 0 || arms.length === 0) throw Object.assign(new Error("pick at least one task and one arm"), { status: 422 });
		for (const id of taskIds) {
			const task = this.o.store.getTask(id);
			if (!task) throw Object.assign(new Error(`task ${id} does not exist`), { status: 422 });
			if (task.finalState.length === 0) throw Object.assign(new Error(`task "${task.title}" has no final-state criteria yet`), { status: 422 });
		}
		for (const arm of arms) {
			if (arm.variantId && !exp.variants.some((v) => v.id === arm.variantId)) throw Object.assign(new Error(`arm ${arm.label} points at a missing variant`), { status: 422 });
		}
		const repeats = Math.max(1, only?.repeats ?? exp.repeats);
		const run: BenchRun = {
			id: newId("run"),
			experimentId: exp.id,
			trigger,
			status: "running",
			createdAt: new Date().toISOString(),
			environment: await this.environment(),
			arms: structuredClone(arms),
			variants: structuredClone(exp.variants),
			taskIds: [...taskIds],
			trials: [],
		};
		for (const taskId of taskIds) {
			for (const arm of arms) {
				for (let repeat = 0; repeat < repeats; repeat++) {
					run.trials.push({ id: newId("trial"), runId: run.id, taskId, armId: arm.id, repeat, status: "queued", warnings: [] });
				}
			}
		}
		this.o.store.saveRun(run);
		this.o.store.saveExperiment({ ...exp, lastRunId: run.id, lastRunAt: run.createdAt, updatedAt: new Date().toISOString() });
		const active: ActiveRun = { run, procs: new Set(), cancelled: false };
		this.active.set(run.id, active);
		void this.execute(active, Math.max(1, exp.concurrency)).catch((e) => log.error(`run ${run.id} crashed`, e));
		return run;
	}

	cancel(runId: string): boolean {
		const a = this.active.get(runId);
		if (!a) return false;
		a.cancelled = true;
		for (const p of a.procs) p.cancel();
		for (const t of a.run.trials) if (t.status === "queued") t.status = "cancelled";
		this.save(a.run);
		return true;
	}

	private save(run: BenchRun): void {
		this.o.store.saveRun(run);
	}

	private async execute(a: ActiveRun, concurrency: number): Promise<void> {
		const queue = [...a.run.trials];
		const worker = async () => {
			for (let t = queue.shift(); t; t = queue.shift()) {
				if (a.cancelled || t.status !== "queued") continue;
				await this.runTrial(a, t);
			}
		};
		await Promise.all(Array.from({ length: concurrency }, worker));
		a.run.status = a.cancelled ? "cancelled" : "done";
		a.run.endedAt = new Date().toISOString();
		this.save(a.run);
		this.active.delete(a.run.id);
		log.info(`run ${a.run.id} ${a.run.status}`);
	}

	trialDir(runId: string, trialId: string): string {
		return join(this.o.store.runDir(runId), "trials", trialId);
	}

	private async runTrial(a: ActiveRun, trial: Trial): Promise<void> {
		const run = a.run;
		const task = this.o.store.getTask(trial.taskId);
		const arm = run.arms.find((x) => x.id === trial.armId);
		const dir = this.trialDir(run.id, trial.id);
		const ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		trial.status = "preparing";
		trial.startedAt = new Date().toISOString();
		trial.workspaceDir = ws;
		this.save(run);
		try {
			if (!task || !arm) throw new Error("task or arm disappeared");
			const variant = arm.variantId ? run.variants.find((v) => v.id === arm.variantId) : undefined;
			await this.prepareWorkspace(task, ws, trial);
			trial.status = "running";
			this.save(run);
			const t0 = Date.now();
			const outcome = arm.harness === "prime-agent" ? await this.runPrimeAgent(a, task, arm, variant, trial, dir, ws) : await this.runClaudeCode(a, task, arm, variant, trial, dir, ws);
			trial.durationMs = Date.now() - t0;
			trial.exitCode = outcome.exitCode;
			trial.costUsd = outcome.costUsd;
			trial.tokens = outcome.tokens;
			trial.sessionFile = outcome.sessionFile;
			writeJsonAtomic(join(dir, "rows.json"), outcome.rows);
			if (a.cancelled) {
				trial.status = "cancelled";
				return;
			}
			if (outcome.timedOut) trial.warnings.push(`timed out after ${task.runOptions.timeoutMinutes} min; judged on what was done`);
			if (outcome.empty) {
				trial.status = "error";
				trial.error = `the agent produced no transcript (exit ${outcome.exitCode}): ${outcome.stderrTail.trim().split("\n").slice(-3).join(" | ")}`;
				return;
			}
			trial.status = "judging";
			this.save(run);
			trial.verdict = await this.judge(task, trial, outcome.rows, ws);
			trial.status = trial.verdict.passed ? "passed" : "failed";
		} catch (e) {
			trial.status = a.cancelled ? "cancelled" : "error";
			trial.error = e instanceof Error ? e.message : String(e);
			log.warn(`trial ${trial.id} failed`, e);
		} finally {
			trial.endedAt = new Date().toISOString();
			this.save(run);
		}
	}

	private async prepareWorkspace(task: BenchTask, ws: string, trial: Trial): Promise<void> {
		const w = task.snapshot.workspace;
		if (w.commit && w.cwd) {
			await this.o.recorder.materialize(w.cwd, w.commit, ws);
			if (w.lagSeconds !== undefined && (w.lagSeconds > LAG_WARN_SECONDS || w.lagSeconds < -60)) {
				trial.warnings.push(`workspace was recorded ${Math.round(Math.abs(w.lagSeconds) / 60)} min ${w.lagSeconds < 0 ? "after" : "before"} the checkpoint; files may differ from that moment`);
			}
		} else {
			trial.warnings.push("no workspace was recorded for this checkpoint; the trial started in an empty directory");
		}
		// A private repo in the trial workspace, so the judge sees exactly what the agent changed.
		await git(ws, ["init", "-q"]);
		await git(ws, ["add", "-A"]);
		await git(ws, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "checkpoint baseline"]);
	}

	private writeMemory(mode: Arm["memory"], task: BenchTask, agentDir: string): void {
		const snap = this.o.store.snapshotDir(task.id);
		const local = readJsonFile<Record<string, unknown>>(join(snap, SNAPSHOT_FILES.localHarness));
		if (mode === "none") return;
		let global: Record<string, unknown> | undefined;
		if (mode === "snapshot") {
			global = readJsonFile(join(snap, SNAPSHOT_FILES.globalHarness));
			if (existsSync(join(snap, SNAPSHOT_FILES.skills))) cpSync(join(snap, SNAPSHOT_FILES.skills), join(agentDir, "skills"), { recursive: true });
		} else {
			// "current": today's memory, minus anything the capture proved was written after the checkpoint.
			const excluded = new Set(task.snapshot.harness.excludedEntries.filter((e) => e.scope === "global").map((e) => `${e.kind}:${e.id}`));
			global = readJsonFile(join(this.o.paths.globalHarnessDir, "harness_state.json"));
			const entries = (global?.entries ?? {}) as Record<string, Record<string, unknown>>;
			for (const [kind, bucket] of Object.entries(entries)) for (const id of Object.keys(bucket ?? {})) if (excluded.has(`${kind}:${id}`)) delete bucket[id];
			const skipSkills = new Set(task.snapshot.harness.excludedSkills.map((s) => s.name));
			if (existsSync(this.o.paths.skillsDir)) {
				for (const name of readdirSync(this.o.paths.skillsDir)) {
					if (name.startsWith(".") || skipSkills.has(name)) continue;
					cpSync(join(this.o.paths.skillsDir, name), join(agentDir, "skills", name), { recursive: true });
				}
			}
		}
		const merged = mergeHarnessRaw(global, local);
		if (merged) writeJsonAtomic(join(agentDir, "harness", "harness_state.json"), merged);
	}

	private async runPrimeAgent(a: ActiveRun, task: BenchTask, arm: Arm, variant: Variant | undefined, trial: Trial, dir: string, ws: string): Promise<ArmOutcome> {
		const agentDir = join(dir, "agent");
		const sessionsDir = join(dir, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		const snapDir = this.o.store.snapshotDir(task.id);
		const liveAuth = join(this.o.paths.agentDir, "auth.json");
		if (existsSync(liveAuth)) {
			cpSync(liveAuth, join(agentDir, "auth.json"));
			chmodSync(join(agentDir, "auth.json"), 0o600);
		}
		for (const [snapName, live] of [
			[SNAPSHOT_FILES.models, this.o.paths.modelsFile],
			[SNAPSHOT_FILES.settings, this.o.paths.settingsFile],
		] as const) {
			const src = existsSync(join(snapDir, snapName)) ? join(snapDir, snapName) : live;
			if (existsSync(src)) cpSync(src, join(agentDir, snapName));
		}
		this.writeMemory(arm.memory, task, agentDir);
		const snapshotFile = join(dir, "snapshot.jsonl");
		cpSync(join(snapDir, SNAPSHOT_FILES.session), snapshotFile);

		const socket = benchSocketPath(`t${createHash("sha1").update(trial.id).digest("hex").slice(0, 12)}`);
		const args = ["-p", "--mode", "json", "--daemon-socket", socket, "--fork", snapshotFile, "--session-dir", sessionsDir, ...modelArgs(arm.model)];
		if (arm.thinking) args.push("--thinking", arm.thinking);
		if (task.runOptions.autonomous) args.push("--autonomous");
		let prompt = task.prompt;
		if (variant && arm.insertion === "system-prompt") args.push("--append-system-prompt", skillBlock(variant));
		if (variant && arm.insertion === "first-message") prompt = `${skillBlock(variant)}\n\n${prompt}`;
		args.push("--", prompt);

		const proc = runProcess({
			bin: this.o.primeAgentBin,
			args,
			cwd: ws,
			env: helperEnv(this.o.env ?? process.env, { PRIME_AGENT_CODING_AGENT_DIR: agentDir }),
			stdoutPath: join(dir, "out.jsonl"),
			timeoutMs: task.runOptions.timeoutMinutes * 60_000,
		});
		a.procs.add(proc);
		const res = await proc.done.finally(() => a.procs.delete(proc));
		await shutdownDaemonAt(socket);

		const sessionFile = newestJsonl(sessionsDir);
		if (!sessionFile) return { rows: [], exitCode: res.code, timedOut: res.timedOut, stderrTail: res.stderrTail, empty: true };
		const [trialParsed, snapParsed] = await Promise.all([parseSessionFile(sessionFile), parseSessionFile(snapshotFile)]);
		const snapIds = new Set(snapParsed.entries.map((e) => e.id));
		const fresh = currentBranch(trialParsed.entries).filter((e) => !snapIds.has(e.id));
		const rows = toTimeline(fresh, 3000);
		const u = trialParsed.summary.usage;
		const s = snapParsed.summary.usage;
		return {
			rows,
			exitCode: res.code,
			timedOut: res.timedOut,
			stderrTail: res.stderrTail,
			costUsd: Math.max(0, u.cost + u.childCost - (s.cost + s.childCost)),
			tokens: { input: u.input - s.input, output: u.output - s.output, cacheRead: u.cacheRead - s.cacheRead, cacheWrite: u.cacheWrite - s.cacheWrite },
			sessionFile,
			empty: !rows.some((r) => r.role === "assistant"),
		};
	}

	private async runClaudeCode(a: ActiveRun, task: BenchTask, arm: Arm, variant: Variant | undefined, trial: Trial, dir: string, ws: string): Promise<ArmOutcome> {
		const { env, isolated } = this.o.meta.claudeEnv(join(dir, "cc-config"));
		if (!isolated) trial.warnings.push("no CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_OAUTH_TOKEN in the observer env: Claude Code ran with the operator's ~/.claude, so personal CLAUDE.md, skills and plugins may have leaked in");
		const snapParsed = await parseSessionFile(join(this.o.store.snapshotDir(task.id), SNAPSHOT_FILES.session));
		const context = [CC_PREAMBLE, renderTranscript(toTimeline(currentBranch(snapParsed.entries), 3000), 150_000)];
		if (variant && arm.insertion === "system-prompt") context.push(skillBlock(variant));
		const contextFile = join(dir, "context.md");
		writeFileSync(contextFile, context.join("\n\n"));
		let prompt = task.prompt;
		if (variant && arm.insertion === "first-message") prompt = `${skillBlock(variant)}\n\n${prompt}`;
		const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", arm.model, "--permission-mode", "bypassPermissions", "--append-system-prompt-file", contextFile, "--session-id", randomUUID()];
		const outPath = join(dir, "out.jsonl");
		const proc = runProcess({ bin: this.o.meta.claudeBin, args, cwd: ws, env, stdoutPath: outPath, stdin: prompt, timeoutMs: task.runOptions.timeoutMinutes * 60_000 });
		a.procs.add(proc);
		const res = await proc.done.finally(() => a.procs.delete(proc));
		const summary = parseClaudeStream(safeRead(outPath));
		if (summary.isError && summary.resultText) trial.warnings.push(`claude code reported an error: ${summary.resultText.slice(0, 300)}`);
		return {
			rows: summary.rows,
			exitCode: res.code,
			timedOut: res.timedOut,
			stderrTail: res.stderrTail,
			costUsd: summary.costUsd,
			tokens: summary.tokens,
			empty: !summary.rows.some((r) => r.role === "assistant"),
		};
	}

	private async judge(task: BenchTask, trial: Trial, rows: TimelineEntry[], ws: string): Promise<JudgeVerdict> {
		await git(ws, ["add", "-A"]).catch(() => "");
		const stat = await git(ws, ["diff", "--cached", "--stat", "HEAD"]).catch(() => "");
		const settings = this.o.settings();
		const criteria = task.finalState.map((c) => `- ${c.id}${c.required ? " (required)" : ""}: ${c.text}`).join("\n");
		const prompt = [
			`## Goal\n${task.goal || "(none written)"}`,
			`## Prompt the agent received\n${task.prompt}`,
			task.desiredTrajectory ? `## Operator's desired trajectory (judge-only)\n${task.desiredTrajectory}` : "",
			`## Final-state criteria\n${criteria}`,
			task.judgeInstructions ? `## Judge instructions\n${task.judgeInstructions}` : "",
			`## Workspace changes since the checkpoint (git diff --stat)\n${stat.trim().split("\n").slice(-60).join("\n") || "(no file changes)"}`,
			trial.warnings.length ? `## Trial warnings\n${trial.warnings.map((w) => `- ${w}`).join("\n")}` : "",
			`## Trial transcript (everything after the checkpoint)\n${renderTranscript(rows, 110_000)}`,
			`Return one verdict entry for each criterion id: ${task.finalState.map((c) => c.id).join(", ")}.`,
		]
			.filter(Boolean)
			.join("\n\n");
		const res = await this.o.meta.call<Omit<JudgeVerdict, "judgeModel" | "at" | "costUsd">>({
			label: `judge-${trial.id}`,
			system: JUDGE_SYSTEM,
			prompt,
			schema: JUDGE_SCHEMA,
			model: settings.meta.judgeModel,
			tools: "read",
			cwd: ws,
			timeoutMs: 30 * 60_000,
		});
		return normalizeVerdict(task, res.data, res.model, res.costUsd);
	}

	async environment(): Promise<RunEnvironment> {
		const env: RunEnvironment = { harnessVersion: this.o.harnessVersion };
		env.repoCommit = (await git(this.o.repoRoot, ["rev-parse", "HEAD"]).catch(() => "")).trim() || undefined;
		env.claudeCodeVersion = (await execText(this.o.meta.claudeBin, ["--version"], this.o.repoRoot).catch(() => "")).trim() || undefined;
		const h = createHash("sha1");
		h.update(safeRead(join(this.o.paths.globalHarnessDir, "harness_state.json")));
		if (existsSync(this.o.paths.skillsDir)) for (const s of readdirSync(this.o.paths.skillsDir).sort()) h.update(`${s}:${statSync(join(this.o.paths.skillsDir, s)).mtimeMs}`);
		env.memoryStamp = h.digest("hex").slice(0, 12);
		return env;
	}
}

/** Required criteria are enforced here, not left to the judge's own `passed`. */
export function normalizeVerdict(task: BenchTask, raw: { passed?: unknown; score?: unknown; summary?: unknown; criteria?: unknown }, model: string, costUsd?: number): JudgeVerdict {
	const given = new Map<string, { met: boolean; evidence: string }>();
	if (Array.isArray(raw.criteria)) {
		for (const c of raw.criteria as Array<{ id?: unknown; met?: unknown; evidence?: unknown }>) {
			if (typeof c?.id === "string") given.set(c.id, { met: c.met === true, evidence: String(c.evidence ?? "") });
		}
	}
	const criteria = task.finalState.map((c) => ({ id: c.id, met: given.get(c.id)?.met ?? false, evidence: given.get(c.id)?.evidence ?? "not assessed by the judge" }));
	const requiredMet = task.finalState.filter((c) => c.required).every((c) => criteria.find((x) => x.id === c.id)?.met);
	const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? Math.min(1, Math.max(0, raw.score)) : 0;
	return { passed: raw.passed === true && requiredMet, score, summary: String(raw.summary ?? ""), criteria, judgeModel: model, costUsd, at: new Date().toISOString() };
}

export function mergeHarnessRaw(global: Record<string, unknown> | undefined, local: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!global && !local) return undefined;
	const g = (global?.entries ?? {}) as Record<string, Record<string, unknown>>;
	const l = (local?.entries ?? {}) as Record<string, Record<string, unknown>>;
	const entries: Record<string, Record<string, unknown>> = {};
	for (const kind of new Set([...Object.keys(g), ...Object.keys(l)])) entries[kind] = { ...(g[kind] ?? {}), ...(l[kind] ?? {}) };
	const refinements = [...(Array.isArray(global?.refinements) ? global.refinements : []), ...(Array.isArray(local?.refinements) ? local.refinements : [])];
	return { schema: Math.max(Number(global?.schema ?? 1), Number(local?.schema ?? 1)), entries, refinements };
}

export function modelArgs(model: string): string[] {
	const slash = model.indexOf("/");
	return slash > 0 ? ["--provider", model.slice(0, slash), "--model", model.slice(slash + 1)] : ["--model", model];
}

function newestJsonl(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
		.sort((x, y) => y.m - x.m)[0]?.f;
}

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function execText(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(bin, args, { cwd, env: env ?? process.env, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

function git(cwd: string, args: string[]): Promise<string> {
	return execText("git", ["-c", "user.name=prime-bench", "-c", "user.email=bench@observer.local", "-c", "gc.auto=0", ...args], cwd, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
}
