// Checkpoint benchmarks: frozen starting snapshots mined from real sessions, harness experiments
// run against them, and a live advisor that plugs benchmark-verified skills into running sessions.
// Shared by server and web; everything here is plain JSON persisted under <dataDir>/bench/.

export type BenchTaskSource = "intervention" | "miner" | "manual";
export type BenchTaskStatus = "draft" | "ready" | "archived";

export interface FinalStateCriterion {
	id: string;
	text: string;
	/** Must-pass criteria fail the trial on their own; the rest only lower the score. */
	required: boolean;
}

export interface WorkspaceRef {
	cwd: string;
	/** Commit in the shadow recorder repo nearest before the checkpoint; absent when nothing was recorded. */
	commit?: string;
	committedAt?: string;
	/** Seconds between the recorded workspace state and the checkpoint. Large values mean the files may not match. */
	lagSeconds?: number;
	fileCount?: number;
}

export interface HarnessSnapshotInfo {
	includedEntries: Array<{ kind: string; id: string; title: string; scope: string }>;
	/** Entries created or changed after the checkpoint: excluded so a run cannot read its own solution. */
	excludedEntries: Array<{ kind: string; id: string; title: string; scope: string; reason: string }>;
	includedSkills: string[];
	excludedSkills: Array<{ name: string; reason: string }>;
}

export interface BenchTask {
	id: string;
	title: string;
	status: BenchTaskStatus;
	source: BenchTaskSource;
	createdAt: string;
	updatedAt: string;
	/** What the checkpoint is about, one paragraph. */
	goal: string;
	/** Sent to the agent when the trial starts. */
	prompt: string;
	finalState: FinalStateCriterion[];
	/** Extra instructions for the LLM judge (taste, what to inspect, what to ignore). */
	judgeInstructions: string;
	/** The trajectory Eray wanted instead of the one the agent took. Judge-only; never shown to the agent. */
	desiredTrajectory?: string;
	tags: string[];
	origin: {
		sessionId: string;
		sessionFile: string;
		/** Entry the snapshot is anchored at. */
		anchorEntryId: string;
		anchorAt: string;
		/** "before-user-message": snapshot ends before the anchor user message, whose text is the prompt.
		 *  "mid-turn": snapshot includes the anchor entry and the prompt asks the agent to continue. */
		cut: "before-user-message" | "mid-turn";
		model?: string;
		provider?: string;
		thinkingLevel?: string;
		harnessVersion?: string;
		repoCommit?: string;
		candidateId?: string;
	};
	snapshot: {
		messageCount: number;
		entryCount: number;
		workspace: WorkspaceRef;
		harness: HarnessSnapshotInfo;
	};
	/** Optional flags for the trial, e.g. autonomous mode for "do not stop until" tasks. */
	runOptions: {
		timeoutMinutes: number;
		autonomous: boolean;
	};
}

export type CandidateKind = "decision" | "setup" | "research" | "creative" | "delivery" | "recovery" | "other";
export type CandidateStatus = "pending" | "accepted" | "rejected";

export interface BenchCandidate {
	id: string;
	status: CandidateStatus;
	createdAt: string;
	sessionId: string;
	sessionFile: string;
	anchorEntryId: string;
	anchorAt: string;
	kind: CandidateKind;
	title: string;
	summary: string;
	/** What the agent decided at this point. */
	decision: string;
	/** Why this is worth a benchmark. */
	whyMajor: string;
	alternatives: string[];
	evidenceEntryIds: string[];
	/** Tool-result images near the anchor (browser screenshots etc.), as entry ids + indexes. */
	images: Array<{ entryId: string; index: number; mimeType: string }>;
	taskId?: string;
	minerRunId: string;
}

export type ArmHarness = "prime-agent" | "claude-code";
export type MemoryMode = "snapshot" | "current" | "none";
export type InsertionMode = "system-prompt" | "first-message";

export interface Variant {
	id: string;
	name: string;
	/** Full SKILL.md text (frontmatter + body). */
	skill: string;
	notes?: string;
	/** Promotion after the results justified it. */
	promoted?: { at: string; scope: "global" | "advisor"; installedPath?: string };
}

export interface Arm {
	id: string;
	label: string;
	harness: ArmHarness;
	/** null = the raw harness, no inserted context. */
	variantId: string | null;
	/** "provider/model" for prime-agent, a Claude Code model alias or id for claude-code. */
	model: string;
	thinking?: string;
	memory: MemoryMode;
	insertion: InsertionMode;
}

export interface Experiment {
	id: string;
	title: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	taskIds: string[];
	variants: Variant[];
	arms: Arm[];
	repeats: number;
	concurrency: number;
	/** Re-run cadence; memories, models and closed-source harnesses change underneath, so results age. */
	schedule: { everyDays: number } | null;
	lastRunId?: string;
	lastRunAt?: string;
}

export type TrialStatus = "queued" | "preparing" | "running" | "judging" | "passed" | "failed" | "error" | "cancelled";

export interface JudgeVerdict {
	passed: boolean;
	score: number;
	summary: string;
	criteria: Array<{ id: string; met: boolean; evidence: string }>;
	judgeModel: string;
	costUsd?: number;
	at: string;
}

export interface Trial {
	id: string;
	runId: string;
	taskId: string;
	armId: string;
	repeat: number;
	status: TrialStatus;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	costUsd?: number;
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	exitCode?: number | null;
	error?: string;
	sessionFile?: string;
	workspaceDir?: string;
	verdict?: JudgeVerdict;
	/** Warnings about fidelity, e.g. the workspace was not recorded at the checkpoint. */
	warnings: string[];
}

export interface RunEnvironment {
	repoCommit?: string;
	harnessVersion?: string;
	claudeCodeVersion?: string;
	/** Hash of the live global harness_state.json + skills listing at run time (memory drift marker). */
	memoryStamp?: string;
}

export interface BenchRun {
	id: string;
	experimentId: string;
	trigger: "manual" | "schedule";
	status: "running" | "done" | "cancelled" | "error";
	createdAt: string;
	endedAt?: string;
	environment: RunEnvironment;
	/** Frozen copy of the experiment's arms/variants at launch, so edits don't rewrite history. */
	arms: Arm[];
	variants: Variant[];
	taskIds: string[];
	trials: Trial[];
}

export interface ArmResult {
	armId: string;
	label: string;
	trials: number;
	finished: number;
	passed: number;
	passRate: number | null;
	meanScore: number | null;
	costUsd: number;
	meanDurationMs: number | null;
}

export interface RunMatrixCell {
	taskId: string;
	armId: string;
	passed: number;
	finished: number;
	meanScore: number | null;
}

export interface RunSummary {
	runId: string;
	createdAt: string;
	status: BenchRun["status"];
	arms: ArmResult[];
	cells: RunMatrixCell[];
}

export type AdvisorMode = "off" | "suggest" | "auto";

export interface AdvisorSettings {
	mode: AdvisorMode;
	intervalMinutes: number;
	/** Minimum pass-rate lift over the matching raw arm before a variant counts as verified. */
	minLift: number;
	model: string;
}

export interface AdvisorEvent {
	id: string;
	at: string;
	sessionId: string;
	activeSessionId?: string;
	major: boolean;
	stepSummary: string;
	chosenVariantIds: string[];
	message?: string;
	/** "sent" when injected, "suggested" in suggest mode, "skipped" when nothing fit. */
	action: "sent" | "suggested" | "skipped" | "dismissed" | "error";
	error?: string;
}

export interface VerifiedSkill {
	experimentId: string;
	experimentTitle: string;
	variant: Variant;
	armId: string;
	lift: number;
	passRate: number;
	baselinePassRate: number;
	taskTitles: string[];
	runId: string;
}

export interface MetaSettings {
	/** Which CLI runs the benchmark's own helper agents (capture drafting, miner, judge, advisor). */
	backend: "claude-code" | "prime-agent";
	model: string;
	judgeModel: string;
}

export interface BenchSettings {
	meta: MetaSettings;
	advisor: AdvisorSettings;
	recorder: { enabled: boolean; periodicMinutes: number };
	miner: { autoOnIdleMinutes: number | null };
	intervention: { enabled: boolean };
}

export const DEFAULT_BENCH_SETTINGS: BenchSettings = {
	meta: { backend: "claude-code", model: "sonnet", judgeModel: "opus" },
	advisor: { mode: "off", intervalMinutes: 10, minLift: 0.1, model: "sonnet" },
	recorder: { enabled: true, periodicMinutes: 5 },
	miner: { autoOnIdleMinutes: null },
	intervention: { enabled: true },
};

export interface BenchOverview {
	tasks: BenchTask[];
	candidates: BenchCandidate[];
	experiments: Experiment[];
	runs: RunSummary[];
	settings: BenchSettings;
	jobs: BenchJob[];
}

/** Background helper work (capture drafting, mining, variant generation) visible in the UI. */
export interface BenchJob {
	id: string;
	kind: "capture" | "mine" | "variants" | "intervention" | "advisor";
	label: string;
	status: "running" | "done" | "error";
	startedAt: string;
	endedAt?: string;
	error?: string;
	resultIds?: string[];
}

export interface CaptureRequest {
	sessionId: string;
	anchorEntryId?: string;
	title?: string;
	desiredTrajectory?: string;
	/** Skip the LLM draft of goal/final state; fill in by hand. */
	noDraft?: boolean;
}

export interface TimelineEntry {
	id: string;
	parentId: string | null;
	at: string;
	role: "user" | "assistant" | "tool" | "system" | "other";
	text: string;
	toolName?: string;
	imageCount: number;
}
