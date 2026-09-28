import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Arm,
	BenchJob,
	BenchOverview,
	BenchRun,
	BenchSettings,
	BenchTask,
	CaptureRequest,
	Experiment,
	FinalStateCriterion,
	RunSummary,
	TimelineEntry,
	Variant,
	VerifiedSkill,
} from "../../shared/bench.ts";
import type { DaemonCommands } from "../daemon/commands.ts";
import type { AgentPaths } from "../disk/paths.ts";
import { parseSessionFile } from "../disk/sessions-reader.ts";
import type { AgentDirWatcher } from "../disk/watcher.ts";
import type { FleetService } from "../fleet/fleet-service.ts";
import { logger } from "../log.ts";
import { SessionActivity, type SessionUserMessage } from "./activity.ts";
import { Advisor, type LiveSession } from "./advisor.ts";
import { type CaptureDeps, SNAPSHOT_FILES, captureTask } from "./capture.ts";
import { generateVariants, slug } from "./designer.ts";
import { classifyIntervention, interventionNotes, looksLikeIntervention } from "./intervention.ts";
import { MetaAgent } from "./meta-agent.ts";
import { mineSession, readEntryImage } from "./miner.ts";
import { WorkspaceRecorder } from "./recorder.ts";
import { summarizeRun, verifiedSkills } from "./results.ts";
import { BenchRunner } from "./runner.ts";
import { currentBranch, toTimeline } from "./snapshot.ts";
import { BenchStore, newId, readJsonFile, writeJsonAtomic } from "./store.ts";

const log = logger("bench");

export interface BenchServiceOptions {
	dataDir: string;
	paths: AgentPaths;
	primeAgentBin: string;
	repoRoot: string;
	harnessVersion: string;
	fleet: FleetService;
	commands: DaemonCommands;
	watcher: AgentDirWatcher;
	claudeBin?: string;
	env?: NodeJS.ProcessEnv;
}

export interface CreateExperimentInput {
	title: string;
	description: string;
	taskIds?: string[];
	variantCount?: number;
	models?: { primeAgent?: string; claudeCode?: string };
	includeClaudeCode?: boolean;
	repeats?: number;
	concurrency?: number;
	schedule?: { everyDays: number } | null;
}

const DEFAULT_MODELS = { primeAgent: "anthropic/claude-opus-5", claudeCode: "opus" };

function httpError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

export class BenchService {
	readonly store: BenchStore;
	readonly recorder: WorkspaceRecorder;
	readonly meta: MetaAgent;
	readonly runner: BenchRunner;
	readonly activity: SessionActivity;
	readonly advisor: Advisor;
	private timers: NodeJS.Timeout[] = [];
	private unsubscribe: (() => void) | undefined;
	private lastPeriodic = new Map<string, number>();
	private mining = false;

	constructor(private readonly o: BenchServiceOptions) {
		this.store = new BenchStore(o.dataDir);
		this.recorder = new WorkspaceRecorder(this.store.shadowDir, { skipUnder: [this.store.root] });
		this.meta = new MetaAgent({ settings: () => this.store.settings().meta, workDir: this.store.root, agentDir: o.paths.agentDir, primeAgentBin: o.primeAgentBin, claudeBin: o.claudeBin, env: o.env });
		this.runner = new BenchRunner({
			store: this.store,
			recorder: this.recorder,
			meta: this.meta,
			paths: o.paths,
			settings: () => this.store.settings(),
			primeAgentBin: o.primeAgentBin,
			repoRoot: o.repoRoot,
			harnessVersion: o.harnessVersion,
			env: o.env,
		});
		this.activity = new SessionActivity(o.paths.sessionsDir, join(this.store.root, "activity-state.json"));
		this.advisor = new Advisor({
			store: this.store,
			meta: this.meta,
			liveSessions: () => this.liveSessions(),
			verified: () => this.verified(),
			inject: (id, message, streaming) => this.inject(id, message, streaming),
			onEvent: () => this.store.changed("advisor"),
		});
	}

	start(): void {
		this.runner.recoverOnBoot();
		// Sessions seen for the first time start at their end (history is not new activity); known ones
		// resume from their saved offsets, so a "benchmark this" sent while the observer was restarting
		// still gets handled. Discarding this scan's result used to swallow exactly those messages.
		this.onSessionFiles(this.o.fleet.sessionFiles());
		this.unsubscribe = this.o.watcher.onChange((events) => {
			const files = events.filter((e) => e.area === "sessions").map((e) => e.path);
			if (files.length > 0) this.onSessionFiles(files);
		});
		const every = (ms: number, fn: () => unknown) => {
			const t = setInterval(() => {
				try {
					const r = fn();
					if (r instanceof Promise) r.catch((e) => log.warn("bench timer failed", e));
				} catch (e) {
					log.warn("bench timer failed", e);
				}
			}, ms);
			t.unref();
			this.timers.push(t);
		};
		// Safety net under the watcher: Node's recursive fs.watch on Linux stopped reporting appends to
		// a session created after startup (2026-09-28, the VPS sandbox), so a "benchmark this" never
		// reached the intervention detector. Unchanged files cost one stat each.
		every(3_000, () => this.onSessionFiles(this.rootSessionFiles()));
		every(60_000, () => this.periodicRecord());
		every(10 * 60_000, () => this.scheduleTick());
		every(5 * 60_000, () => this.autoMineTick());
		this.advisor.start();
	}

	stop(): void {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.unsubscribe?.();
		this.advisor.stop();
		this.activity.flush();
	}

	private captureDeps(): CaptureDeps {
		return { store: this.store, recorder: this.recorder, meta: this.meta, paths: this.o.paths, harnessVersion: this.o.harnessVersion };
	}

	// ---- session activity: workspace recording + operator interventions ---------------------
	private onSessionFiles(files: string[]): void {
		const { users } = this.activity.scan(files);
		const s = this.store.settings();
		for (const u of users) {
			if (s.recorder.enabled && this.recorder.recordable(u.cwd)) {
				void this.recorder.record(u.cwd, `user message ${u.entry.id} in session ${u.sessionId}`);
				this.lastPeriodic.set(u.cwd, Date.now());
			}
			if (s.intervention.enabled && looksLikeIntervention(u.text)) void this.handleIntervention(u);
		}
	}

	private rootSessionFiles(): string[] {
		try {
			return readdirSync(this.o.paths.sessionsDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => join(this.o.paths.sessionsDir, f));
		} catch {
			return [];
		}
	}

	private periodicRecord(): void {
		const s = this.store.settings().recorder;
		if (!s.enabled) return;
		const window = s.periodicMinutes * 60_000;
		for (const f of this.activity.knownFiles()) {
			if (!this.recorder.recordable(f.cwd)) continue;
			if (Date.now() - Date.parse(f.lastActivityAt) > window) continue;
			if (Date.now() - (this.lastPeriodic.get(f.cwd) ?? 0) < window) continue;
			this.lastPeriodic.set(f.cwd, Date.now());
			void this.recorder.record(f.cwd, `periodic while session ${f.sessionId} is active`);
		}
	}

	private async handleIntervention(u: SessionUserMessage): Promise<void> {
		const job = this.store.startJob("intervention", `benchmark request in session ${u.sessionId.slice(0, 8)}: "${u.text.slice(0, 80)}"`);
		try {
			const r = await classifyIntervention(this.meta, u);
			if (!r) {
				job.label += " (helper: not a benchmark request)";
				this.store.finishJob(job, { resultIds: [] });
				return;
			}
			const task = await captureTask(this.captureDeps(), {
				sessionFile: u.sessionFile,
				anchorEntryId: r.anchorEntryId,
				title: r.classification.title,
				desiredTrajectory: r.classification.desiredTrajectory,
				source: "intervention",
				notes: interventionNotes(u),
			});
			this.store.finishJob(job, { resultIds: [task.id] });
		} catch (e) {
			this.store.finishJob(job, { error: e });
		}
	}

	// ---- queries ----------------------------------------------------------------------------
	overview(): BenchOverview {
		return {
			tasks: this.store.listTasks(),
			candidates: this.store.listCandidates(),
			experiments: this.store.listExperiments(),
			runs: this.store.listRuns().map(summarizeRun),
			settings: this.store.settings(),
			jobs: this.store.listJobs(),
		};
	}

	resolveSessionFile(sessionId: string): string {
		const node = this.o.fleet.findNode(sessionId);
		if (node?.sessionFile && node.runtimeKind === "top-level") return node.sessionFile;
		const file = join(this.o.paths.sessionsDir, `${sessionId}.jsonl`);
		if (existsSync(file)) return file;
		if (node?.sessionFile) return node.sessionFile;
		throw httpError(404, `session ${sessionId} not found`);
	}

	async sessionTimeline(sessionId: string): Promise<{ sessionFile: string; rows: TimelineEntry[] }> {
		const sessionFile = this.resolveSessionFile(sessionId);
		const parsed = await parseSessionFile(sessionFile);
		return { sessionFile, rows: toTimeline(currentBranch(parsed.entries), 600) };
	}

	entryImage(sessionId: string, entryId: string, index: number) {
		return readEntryImage(this.resolveSessionFile(sessionId), entryId, index);
	}

	async taskDetail(id: string): Promise<{ task: BenchTask; timeline: TimelineEntry[] }> {
		const task = this.store.getTask(id);
		if (!task) throw httpError(404, "task not found");
		const snap = join(this.store.snapshotDir(id), SNAPSHOT_FILES.session);
		const timeline = existsSync(snap) ? toTimeline(currentBranch((await parseSessionFile(snap)).entries), 1500) : [];
		return { task, timeline };
	}

	// ---- jobs -------------------------------------------------------------------------------
	private job(kind: BenchJob["kind"], label: string, work: () => Promise<string[]>): BenchJob {
		const job = this.store.startJob(kind, label);
		work().then(
			(ids) => this.store.finishJob(job, { resultIds: ids }),
			(e) => {
				log.warn(`${kind} job failed`, e);
				this.store.finishJob(job, { error: e });
			},
		);
		return job;
	}

	capture(req: CaptureRequest): BenchJob {
		const sessionFile = this.resolveSessionFile(req.sessionId);
		return this.job("capture", `capture checkpoint from ${req.sessionId.slice(0, 8)}`, async () => {
			const task = await captureTask(this.captureDeps(), { sessionFile, anchorEntryId: req.anchorEntryId, title: req.title, desiredTrajectory: req.desiredTrajectory, source: "manual", noDraft: req.noDraft });
			return [task.id];
		});
	}

	mine(sessionId: string): BenchJob {
		const sessionFile = this.resolveSessionFile(sessionId);
		const job = this.job("mine", `mine checkpoints from ${sessionId.slice(0, 8)}`, async () => {
			const found = await mineSession(this.store, this.meta, sessionFile, {
				onProgress: (done, total) => {
					job.label = `mine checkpoints from ${sessionId.slice(0, 8)} (window ${done}/${total})`;
					this.store.changed("jobs");
				},
			});
			return found.map((c) => c.id);
		});
		return job;
	}

	acceptCandidate(id: string, body: { desiredTrajectory?: string; title?: string }): BenchJob {
		const c = this.store.getCandidate(id);
		if (!c) throw httpError(404, "candidate not found");
		if (c.status === "accepted" && c.taskId) throw httpError(409, "already accepted");
		this.store.saveCandidate({ ...c, status: "accepted" });
		return this.job("capture", `capture "${c.title}"`, async () => {
			try {
				const task = await captureTask(this.captureDeps(), {
					sessionFile: c.sessionFile,
					anchorEntryId: c.anchorEntryId,
					title: body.title || c.title,
					desiredTrajectory: body.desiredTrajectory,
					source: "miner",
					candidateId: c.id,
					notes: `${c.summary}\nDecision the agent took: ${c.decision}\nWhy it matters: ${c.whyMajor}\nWhat an expert might do instead: ${c.alternatives.join("; ") || "-"}`,
				});
				this.store.saveCandidate({ ...c, status: "accepted", taskId: task.id });
				return [task.id];
			} catch (e) {
				this.store.saveCandidate({ ...c, status: "pending" });
				throw e;
			}
		});
	}

	rejectCandidate(id: string): void {
		const c = this.store.getCandidate(id);
		if (!c) throw httpError(404, "candidate not found");
		this.store.saveCandidate({ ...c, status: c.status === "rejected" ? "pending" : "rejected" });
	}

	// ---- tasks ------------------------------------------------------------------------------
	updateTask(id: string, patch: Partial<BenchTask>): BenchTask {
		const task = this.store.getTask(id);
		if (!task) throw httpError(404, "task not found");
		const next: BenchTask = { ...task, updatedAt: new Date().toISOString() };
		if (typeof patch.title === "string") next.title = patch.title;
		if (typeof patch.goal === "string") next.goal = patch.goal;
		if (typeof patch.prompt === "string") next.prompt = patch.prompt;
		if (typeof patch.judgeInstructions === "string") next.judgeInstructions = patch.judgeInstructions;
		if (typeof patch.desiredTrajectory === "string") next.desiredTrajectory = patch.desiredTrajectory || undefined;
		if (Array.isArray(patch.tags)) next.tags = patch.tags.map(String).filter(Boolean);
		if (patch.status === "draft" || patch.status === "ready" || patch.status === "archived") next.status = patch.status;
		if (Array.isArray(patch.finalState)) next.finalState = normalizeCriteria(patch.finalState);
		if (patch.runOptions) {
			next.runOptions = {
				timeoutMinutes: clampInt(patch.runOptions.timeoutMinutes, 1, 24 * 60, task.runOptions.timeoutMinutes),
				autonomous: typeof patch.runOptions.autonomous === "boolean" ? patch.runOptions.autonomous : task.runOptions.autonomous,
			};
		}
		if (next.status === "ready" && next.finalState.length === 0) throw httpError(422, "a ready task needs at least one final-state criterion");
		return this.store.saveTask(next);
	}

	deleteTask(id: string): void {
		if (this.store.listExperiments().some((e) => e.taskIds.includes(id))) throw httpError(409, "an experiment still uses this task; remove it there or archive the task");
		this.store.deleteTask(id);
	}

	// ---- experiments ------------------------------------------------------------------------
	createExperiment(input: CreateExperimentInput): { experiment: Experiment; job?: BenchJob } {
		if (!input.title?.trim()) throw httpError(422, "title is required");
		const models = { ...DEFAULT_MODELS, ...(input.models ?? {}) };
		const includeClaudeCode = input.includeClaudeCode !== false;
		const now = new Date().toISOString();
		const arms: Arm[] = [{ id: "pa-raw", label: "prime-agent · raw", harness: "prime-agent", variantId: null, model: models.primeAgent, memory: "snapshot", insertion: "system-prompt" }];
		if (includeClaudeCode) arms.push({ id: "cc-raw", label: "claude code · raw", harness: "claude-code", variantId: null, model: models.claudeCode, memory: "none", insertion: "system-prompt" });
		const exp: Experiment = {
			id: newId("exp"),
			title: input.title.trim(),
			description: input.description ?? "",
			createdAt: now,
			updatedAt: now,
			taskIds: (input.taskIds ?? []).filter((id) => this.store.getTask(id)),
			variants: [],
			arms,
			repeats: clampInt(input.repeats, 1, 20, 1),
			concurrency: clampInt(input.concurrency, 1, 8, 2),
			schedule: input.schedule ?? { everyDays: 7 },
		};
		this.store.saveExperiment(exp);
		const count = clampInt(input.variantCount, 0, 6, 3);
		const job = count > 0 ? this.generateVariantsJob(exp.id, count, models, includeClaudeCode) : undefined;
		return { experiment: exp, job };
	}

	generateVariantsJob(expId: string, count: number, models = DEFAULT_MODELS, includeClaudeCode?: boolean): BenchJob {
		const exp = this.store.getExperiment(expId);
		if (!exp) throw httpError(404, "experiment not found");
		return this.job("variants", `write ${count} variant(s) for "${exp.title}"`, async () => {
			const tasks = exp.taskIds.map((id) => this.store.getTask(id)).filter((t): t is BenchTask => !!t);
			const variants = await generateVariants(this.meta, exp, tasks, count);
			const cur = this.store.getExperiment(expId) ?? exp;
			const withCc = includeClaudeCode ?? cur.arms.some((a) => a.harness === "claude-code");
			const paModel = cur.arms.find((a) => a.harness === "prime-agent" && a.variantId === null)?.model ?? models.primeAgent;
			const ccModel = cur.arms.find((a) => a.harness === "claude-code" && a.variantId === null)?.model ?? models.claudeCode;
			const arms = [...cur.arms, ...variants.flatMap((v) => armsForVariant(v, paModel, ccModel, withCc))];
			this.store.saveExperiment({ ...cur, variants: [...cur.variants, ...variants], arms, updatedAt: new Date().toISOString() });
			return variants.map((v) => v.id);
		});
	}

	updateExperiment(id: string, patch: Partial<Experiment>): Experiment {
		const exp = this.store.getExperiment(id);
		if (!exp) throw httpError(404, "experiment not found");
		const next: Experiment = { ...exp, updatedAt: new Date().toISOString() };
		if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim();
		if (typeof patch.description === "string") next.description = patch.description;
		if (Array.isArray(patch.taskIds)) next.taskIds = patch.taskIds.filter((t) => this.store.getTask(t));
		if (Array.isArray(patch.variants)) {
			const seen = new Set<string>();
			next.variants = patch.variants.map((v) => {
				let vid = slug(v.id || v.name);
				while (seen.has(vid)) vid = `${vid}-x`;
				seen.add(vid);
				return { ...v, id: vid, name: String(v.name || vid), skill: String(v.skill ?? "") };
			});
		}
		if (Array.isArray(patch.arms)) {
			const ids = new Set<string>();
			next.arms = patch.arms.map((a) => {
				if (!a.id || ids.has(a.id)) throw httpError(422, `arm ids must be unique (${a.id})`);
				ids.add(a.id);
				if (a.harness !== "prime-agent" && a.harness !== "claude-code") throw httpError(422, `unknown harness ${String(a.harness)}`);
				return { ...a, variantId: a.variantId || null, memory: a.memory ?? "snapshot", insertion: a.insertion ?? "system-prompt" };
			});
		}
		const variantIds = new Set(next.variants.map((v) => v.id));
		for (const a of next.arms) if (a.variantId && !variantIds.has(a.variantId)) throw httpError(422, `arm "${a.label}" uses missing variant ${a.variantId}`);
		if (patch.repeats !== undefined) next.repeats = clampInt(patch.repeats, 1, 20, exp.repeats);
		if (patch.concurrency !== undefined) next.concurrency = clampInt(patch.concurrency, 1, 8, exp.concurrency);
		if (patch.schedule !== undefined) next.schedule = patch.schedule && patch.schedule.everyDays > 0 ? { everyDays: patch.schedule.everyDays } : null;
		return this.store.saveExperiment(next);
	}

	deleteExperiment(id: string): void {
		if (this.runner.isActive(id)) throw httpError(409, "cancel the running run first");
		this.store.deleteExperiment(id);
	}

	/**
	 * Install a variant as a real skill in the live agent dir, so every new session loads it. This
	 * is the "it improved the benchmarks, integrate it" step, and it also changes what future
	 * "current memory" trials see, which is exactly what the weekly re-run should measure.
	 */
	promoteVariant(expId: string, variantId: string): Variant {
		const exp = this.store.getExperiment(expId);
		const v = exp?.variants.find((x) => x.id === variantId);
		if (!exp || !v) throw httpError(404, "variant not found");
		const dir = join(this.o.paths.skillsDir, v.id);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "SKILL.md");
		writeFileSync(file, ensureFrontmatter(v));
		const promoted: Variant = { ...v, promoted: { at: new Date().toISOString(), scope: "global", installedPath: file } };
		this.store.saveExperiment({ ...exp, variants: exp.variants.map((x) => (x.id === v.id ? promoted : x)), updatedAt: new Date().toISOString() });
		return promoted;
	}

	async startRun(expId: string, only?: { taskIds?: string[]; armIds?: string[]; repeats?: number }): Promise<BenchRun> {
		const exp = this.store.getExperiment(expId);
		if (!exp) throw httpError(404, "experiment not found");
		return this.runner.start(exp, "manual", only);
	}

	cancelRun(runId: string): void {
		if (!this.runner.cancel(runId)) throw httpError(409, "that run is not in progress");
	}

	runDetail(runId: string): { run: BenchRun; summary: RunSummary; active: boolean } {
		const run = this.store.getRun(runId);
		if (!run) throw httpError(404, "run not found");
		return { run, summary: summarizeRun(run), active: this.runner.activeRunIds().includes(runId) };
	}

	trialRows(runId: string, trialId: string): TimelineEntry[] {
		return readJsonFile<TimelineEntry[]>(join(this.runner.trialDir(runId, trialId), "rows.json")) ?? [];
	}

	// ---- advisor ----------------------------------------------------------------------------
	liveSessions(): LiveSession[] {
		return this.o.fleet
			.allNodes()
			.filter((n) => n.runtimeKind === "top-level" && n.activeSessionId && n.sessionFile && (n.status === "running" || n.isStreaming))
			.map((n) => ({ sessionId: n.sessionId, sessionFile: n.sessionFile!, activeSessionId: n.activeSessionId!, isStreaming: n.isStreaming }));
	}

	verified(): VerifiedSkill[] {
		const titles = new Map(this.store.listTasks().map((t) => [t.id, t.title]));
		return verifiedSkills(this.store.listExperiments(), this.store.listRuns(), titles, this.store.settings().advisor.minLift);
	}

	private async inject(activeSessionId: string, message: string, streaming: boolean): Promise<void> {
		if (streaming) await this.o.commands.steer(activeSessionId, message);
		else await this.o.commands.followUp(activeSessionId, message);
	}

	async advisorCheck(sessionId: string) {
		const live = this.liveSessions().find((s) => s.sessionId === sessionId || s.activeSessionId === sessionId);
		if (!live) throw httpError(409, "that session is not live");
		return (await this.advisor.evaluate(live)) ?? null;
	}

	advisorSend(eventId: string) {
		const event = this.advisor.events().find((e) => e.id === eventId);
		const live = event ? this.liveSessions().find((s) => s.sessionId === event.sessionId) : undefined;
		return this.advisor.sendSuggestion(eventId, live);
	}

	saveSettings(patch: Partial<BenchSettings>): BenchSettings {
		return this.store.saveSettings(patch);
	}

	// ---- timers -----------------------------------------------------------------------------
	private async scheduleTick(): Promise<void> {
		for (const exp of this.store.listExperiments()) {
			if (!exp.schedule || exp.taskIds.length === 0 || this.runner.isActive(exp.id)) continue;
			const last = exp.lastRunAt ? Date.parse(exp.lastRunAt) : 0;
			if (last && Date.now() - last < exp.schedule.everyDays * 86_400_000) continue;
			// Never auto-start an experiment that was never run by hand: the first run is a deliberate act.
			if (!last) continue;
			log.info(`scheduled re-run of "${exp.title}"`);
			await this.runner.start(exp, "schedule").catch((e) => log.warn(`scheduled run of ${exp.id} refused`, e));
		}
	}

	private async autoMineTick(): Promise<void> {
		const idleMinutes = this.store.settings().miner.autoOnIdleMinutes;
		if (!idleMinutes || this.mining) return;
		const statePath = join(this.store.root, "miner-state.json");
		const state = readJsonFile<Record<string, string>>(statePath) ?? {};
		const live = new Set(this.liveSessions().map((s) => s.sessionFile));
		for (const f of this.activity.knownFiles()) {
			if (live.has(f.sessionFile) || state[f.sessionFile] === f.lastActivityAt) continue;
			if (Date.now() - Date.parse(f.lastActivityAt) < idleMinutes * 60_000) continue;
			state[f.sessionFile] = f.lastActivityAt;
			writeJsonAtomic(statePath, state);
			this.mining = true;
			try {
				await mineSession(this.store, this.meta, f.sessionFile);
			} catch (e) {
				log.warn(`auto-mine of ${f.sessionFile} failed`, e);
			} finally {
				this.mining = false;
			}
			return; // one session per tick
		}
	}
}

function armsForVariant(v: Variant, paModel: string, ccModel: string, withCc: boolean): Arm[] {
	const arms: Arm[] = [{ id: `pa-${v.id}`, label: `prime-agent · ${v.name}`, harness: "prime-agent", variantId: v.id, model: paModel, memory: "snapshot", insertion: "system-prompt" }];
	if (withCc) arms.push({ id: `cc-${v.id}`, label: `claude code · ${v.name}`, harness: "claude-code", variantId: v.id, model: ccModel, memory: "none", insertion: "system-prompt" });
	return arms;
}

export function normalizeCriteria(list: Array<Partial<FinalStateCriterion>>): FinalStateCriterion[] {
	const used = new Set<string>();
	return list
		.filter((c) => typeof c?.text === "string" && c.text.trim())
		.map((c, i) => {
			let id = typeof c.id === "string" && /^[a-z0-9_-]{1,32}$/i.test(c.id) ? c.id : `c${i + 1}`;
			while (used.has(id)) id = `${id}x`;
			used.add(id);
			return { id, text: String(c.text).trim(), required: c.required === true };
		});
}

export function ensureFrontmatter(v: Variant): string {
	const text = v.skill.trim();
	if (text.startsWith("---")) return `${text}\n`;
	return `---\nname: ${v.id}\ndescription: ${v.name.replace(/\n/g, " ")}\n---\n\n${text}\n`;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
