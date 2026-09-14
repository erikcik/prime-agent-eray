import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchTask, BenchTaskSource, FinalStateCriterion, HarnessSnapshotInfo, WorkspaceRef } from "../../shared/bench.ts";
import { loadGlobalRefinementHistory } from "../disk/harness-reader.ts";
import { type AgentPaths, artifactDirForSessionFile } from "../disk/paths.ts";
import { parseSessionFile, type SessionEntry } from "../disk/sessions-reader.ts";
import type { MetaAgent } from "./meta-agent.ts";
import type { WorkspaceRecorder } from "./recorder.ts";
import { buildSnapshotFile, clip, countMessages, currentBranch, filterHarnessState, isUserMessage, renderTranscript, resolveCut, toTimeline } from "./snapshot.ts";
import { type BenchStore, newId, readJsonFile, writeJsonAtomic } from "./store.ts";

export const MID_TURN_PROMPT = "Continue the task from exactly where you left off.";

export interface CaptureDeps {
	store: BenchStore;
	recorder: WorkspaceRecorder;
	meta: MetaAgent;
	paths: AgentPaths;
	harnessVersion: string;
	repoCommit?: string;
}

export interface CaptureInput {
	sessionFile: string;
	anchorEntryId?: string;
	title?: string;
	desiredTrajectory?: string;
	source: BenchTaskSource;
	candidateId?: string;
	noDraft?: boolean;
	/** Extra context for the drafter, e.g. the miner's summary of why this checkpoint matters. */
	notes?: string;
}

/** Files that make up a frozen task, relative to the task's snapshot dir. */
export const SNAPSHOT_FILES = {
	session: "session.jsonl",
	globalHarness: join("harness", "harness_state.json"),
	localHarness: join("local-harness", "harness_state.json"),
	skills: "skills",
	settings: "settings.json",
	models: "models.json",
} as const;

export async function captureTask(deps: CaptureDeps, input: CaptureInput): Promise<BenchTask> {
	const parsed = await parseSessionFile(input.sessionFile);
	const branch = currentBranch(parsed.entries);
	const anchorId = input.anchorEntryId ?? [...branch].reverse().find(isUserMessage)?.id;
	if (!anchorId) throw Object.assign(new Error("session has no user message to anchor a checkpoint at"), { status: 422 });
	const cut = resolveCut(parsed.entries, anchorId);
	const anchorAt = cut.anchor.timestamp;
	const taskId = newId("task");
	const snapDir = deps.store.snapshotDir(taskId);
	mkdirSync(snapDir, { recursive: true });

	// 1. transcript
	writeFileSync(join(snapDir, SNAPSHOT_FILES.session), buildSnapshotFile(parsed.header, cut.kept, randomUUID(), parsed.header?.cwd ?? "/"));

	// 2. memory rewound to the checkpoint
	const harness = await snapshotHarness(deps.paths, input.sessionFile, parsed.summary.refinements, anchorAt, snapDir);

	// 3. skills, settings, model catalog (credentials are never frozen; trials take the live ones)
	const skills = snapshotSkills(deps.paths.skillsDir, anchorAt, join(snapDir, SNAPSHOT_FILES.skills));
	harness.includedSkills = skills.included;
	harness.excludedSkills = skills.excluded;
	for (const [src, dst] of [
		[deps.paths.settingsFile, SNAPSHOT_FILES.settings],
		[deps.paths.modelsFile, SNAPSHOT_FILES.models],
	] as const) {
		if (existsSync(src)) cpSync(src, join(snapDir, dst));
	}

	// 4. workspace
	const workspace = await resolveWorkspace(deps.recorder, parsed.header?.cwd, anchorAt);

	const prompt = cut.cut === "before-user-message" ? (cut.prompt ?? "") : MID_TURN_PROMPT;
	const now = new Date().toISOString();
	let task: BenchTask = {
		id: taskId,
		title: input.title?.trim() || clip(prompt.replace(/\s+/g, " "), 80),
		status: "draft",
		source: input.source,
		createdAt: now,
		updatedAt: now,
		goal: "",
		prompt,
		finalState: [],
		judgeInstructions: "",
		desiredTrajectory: input.desiredTrajectory?.trim() || undefined,
		tags: [],
		origin: {
			sessionId: parsed.summary.sessionId,
			sessionFile: input.sessionFile,
			anchorEntryId: anchorId,
			anchorAt,
			cut: cut.cut,
			model: parsed.summary.model,
			provider: parsed.summary.provider,
			thinkingLevel: parsed.summary.thinkingLevel,
			harnessVersion: deps.harnessVersion,
			repoCommit: deps.repoCommit,
			candidateId: input.candidateId,
		},
		snapshot: {
			messageCount: countMessages(cut.kept),
			entryCount: cut.kept.length,
			workspace,
			harness,
		},
		runOptions: { timeoutMinutes: 60, autonomous: false },
	};
	deps.store.saveTask(task);

	if (!input.noDraft) {
		task = await draftSpec(deps, task, parsed.entries, branch, cut.kept, input.notes);
		deps.store.saveTask(task);
	}
	return task;
}

async function snapshotHarness(
	paths: AgentPaths,
	sessionFile: string,
	sessionRefinements: Parameters<typeof filterHarnessState>[2],
	cutoff: string,
	snapDir: string,
): Promise<HarnessSnapshotInfo> {
	const info: HarnessSnapshotInfo = { includedEntries: [], excludedEntries: [], includedSkills: [], excludedSkills: [] };
	const globalHistory = await loadGlobalRefinementHistory(paths.globalHarnessDir);
	const sources = [
		{ scope: "global", file: join(paths.globalHarnessDir, "harness_state.json"), out: SNAPSHOT_FILES.globalHarness, refinements: globalHistory },
		{ scope: "local", file: join(artifactDirForSessionFile(sessionFile), "harness", "harness_state.json"), out: SNAPSHOT_FILES.localHarness, refinements: sessionRefinements ?? [] },
	];
	for (const s of sources) {
		const raw = readJsonFile<unknown>(s.file);
		if (raw === undefined) continue;
		const r = filterHarnessState(raw, cutoff, s.refinements);
		writeJsonAtomic(join(snapDir, s.out), r.state);
		info.includedEntries.push(...r.included.map((e) => ({ ...e, scope: s.scope })));
		info.excludedEntries.push(...r.excluded.map((e) => ({ ...e, scope: s.scope })));
	}
	return info;
}

/** Skills that did not exist, or were edited, after the checkpoint stay out of the snapshot. */
export function snapshotSkills(skillsDir: string, cutoffIso: string, dest: string): { included: string[]; excluded: Array<{ name: string; reason: string }> } {
	const cutoff = Date.parse(cutoffIso);
	const included: string[] = [];
	const excluded: Array<{ name: string; reason: string }> = [];
	if (!existsSync(skillsDir)) return { included, excluded };
	for (const name of readdirSync(skillsDir)) {
		if (name.startsWith(".")) continue;
		const src = join(skillsDir, name);
		const t = treeTimes(src);
		if (t.born > cutoff) {
			excluded.push({ name, reason: "created after the checkpoint" });
			continue;
		}
		if (t.modified > cutoff) {
			excluded.push({ name, reason: "edited after the checkpoint" });
			continue;
		}
		mkdirSync(dest, { recursive: true });
		cpSync(src, join(dest, name), { recursive: true });
		included.push(name);
	}
	return { included, excluded };
}

function treeTimes(path: string, budget = { files: 3000 }): { born: number; modified: number } {
	const st = statSync(path);
	const born = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
	let modified = st.mtimeMs;
	if (st.isDirectory()) {
		for (const child of readdirSync(path)) {
			if (budget.files-- <= 0) break;
			if (child === "__pycache__" || child === ".venv" || child === "node_modules") continue;
			modified = Math.max(modified, treeTimes(join(path, child), budget).modified);
		}
	}
	return { born, modified };
}

export async function resolveWorkspace(recorder: WorkspaceRecorder, cwd: string | undefined, anchorAt: string): Promise<WorkspaceRef> {
	if (!cwd) return { cwd: "" };
	const lag = (at: string) => Math.round((Date.parse(anchorAt) - Date.parse(at)) / 1000);
	const near = await recorder.nearest(cwd, anchorAt);
	if (near) {
		return { cwd, commit: near.commit, committedAt: near.at, lagSeconds: lag(near.at), fileCount: await recorder.fileCount(cwd, near.commit).catch(() => undefined) };
	}
	// Nothing was recorded before the checkpoint (e.g. a session older than the recorder). Fall
	// back to the files as they are now; the negative lag makes the mismatch visible in the UI.
	if (!recorder.recordable(cwd)) return { cwd };
	const now = await recorder.record(cwd, `bench fallback for checkpoint at ${anchorAt}`);
	if (!now) return { cwd };
	return { cwd, commit: now.commit, committedAt: now.at, lagSeconds: lag(now.at), fileCount: await recorder.fileCount(cwd, now.commit).catch(() => undefined) };
}

// ---- LLM draft of goal / final state / judge instructions --------------------------------------

interface Draft {
	title: string;
	goal: string;
	finalState: Array<{ text: string; required: boolean }>;
	judgeInstructions: string;
	tags: string[];
}

const DRAFT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		title: { type: "string" },
		goal: { type: "string" },
		finalState: {
			type: "array",
			items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, required: { type: "boolean" } }, required: ["text", "required"] },
		},
		judgeInstructions: { type: "string" },
		tags: { type: "array", items: { type: "string" } },
	},
	required: ["title", "goal", "finalState", "judgeInstructions", "tags"],
};

const DRAFT_SYSTEM = `You write checkpoint benchmark specs for a harness-engineering research program.

A checkpoint is a frozen moment in a real, long-horizon agent session (building apps, marketing, running a company). The benchmark re-runs an agent from exactly that moment: it sees only the transcript up to the checkpoint and the checkpoint prompt, in a copy of the workspace as it was then. A separate LLM judge later decides whether the run reached the desired final state, from the run's transcript and workspace files.

Your job is to write, for the operator to review:
- title: short and specific (what decision or step this checkpoint tests).
- goal: one paragraph on what the agent must accomplish from this moment and why it matters.
- finalState: observable success criteria a judge can verify from a transcript and files (decisions stated, sources consulted, files produced, commands run, quality bars met). No vague criteria. Mark required=true only when failing it means the checkpoint failed.
- judgeInstructions: how to judge: what to inspect, what counts as evidence, what to ignore, known failure modes to catch.
- tags: 2-5 lowercase domain tags.

Rules:
- The operator's desired trajectory, when given, defines success. The agent's actual continuation is evidence of the failure mode, not a reference answer.
- Nothing you write is shown to the benchmark agent, but do not leak the operator's exact wording into criteria when a more general, verifiable phrasing exists.
- Reach for expert-level standards of the domain, not generic ones.`;

async function draftSpec(deps: CaptureDeps, task: BenchTask, entries: SessionEntry[], branch: SessionEntry[], kept: SessionEntry[], notes?: string): Promise<BenchTask> {
	const before = renderTranscript(toTimeline(kept, 3000), 60_000);
	const idx = branch.findIndex((e) => e.id === task.origin.anchorEntryId);
	const after = idx >= 0 ? branch.slice(task.origin.cut === "before-user-message" ? idx + 1 : idx + 1) : [];
	const continuation = after.length ? renderTranscript(toTimeline(after, 2500), 40_000) : "(the anchor is not on the session's current branch; no continuation available)";
	const prompt = [
		task.desiredTrajectory ? `## Operator's desired trajectory\n${task.desiredTrajectory}` : "## Operator's desired trajectory\n(none given: infer the expert-level desired outcome)",
		notes ? `## Notes about this checkpoint\n${notes}` : "",
		`## Transcript up to the checkpoint (${entries.length} session entries total)\n${before}`,
		`## Checkpoint\ncut: ${task.origin.cut}\nprompt the benchmark agent will receive:\n${task.prompt}`,
		`## What the original agent actually did next (may be wrong)\n${continuation}`,
	]
		.filter(Boolean)
		.join("\n\n");
	const res = await deps.meta.call<Draft>({ label: `draft-${task.id}`, system: DRAFT_SYSTEM, prompt, schema: DRAFT_SCHEMA });
	const d = res.data;
	const finalState: FinalStateCriterion[] = (d.finalState ?? []).map((c, i) => ({ id: `c${i + 1}`, text: String(c.text ?? ""), required: !!c.required })).filter((c) => c.text);
	return {
		...task,
		title: task.title && task.source !== "miner" && task.title !== clip(task.prompt.replace(/\s+/g, " "), 80) ? task.title : d.title || task.title,
		goal: d.goal ?? "",
		finalState,
		judgeInstructions: d.judgeInstructions ?? "",
		tags: Array.isArray(d.tags) ? d.tags.slice(0, 6).map(String) : [],
		updatedAt: new Date().toISOString(),
	};
}

export function readSnapshotSession(store: BenchStore, taskId: string): string {
	return readFileSync(join(store.snapshotDir(taskId), SNAPSHOT_FILES.session), "utf8");
}
