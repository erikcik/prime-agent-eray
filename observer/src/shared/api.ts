import type { AgentMessageRecord, AgentMessagesStatus } from "./comms.ts";
import type { AgentNode, DaemonInfo, FleetTree } from "./fleet.ts";
import type { HarnessView, RefinementResult, SkillDoc, SkillSummary } from "./harness.ts";

export interface HealthResponse {
	ok: true;
	/** false only in PRIME_OBSERVER_INSECURE_LOCAL loopback mode. */
	authRequired: boolean;
	version: { observer: string; harness: string };
	serverStartedAt: string;
	daemon: DaemonInfo;
	deploy?: { runId: string; running: boolean } | null;
}

export interface SessionDetail {
	node: AgentNode;
	header?: Record<string, unknown>;
	state?: unknown;
	goal?: unknown;
	agentStatus?: { summary: string; taskState?: string; basedOnMessageCount?: number };
	heartbeat?: unknown;
	queue?: unknown;
	artifacts?: SessionArtifacts;
	live: boolean;
}

export interface SessionArtifacts {
	dir?: string;
	subagents: RlmSubagentRecord[];
	scheduledJobs: unknown[];
	hasLocalHarness: boolean;
}

export interface RlmSubagentRecord {
	childId: string;
	sessionName?: string;
	sessionDir?: string;
	sessionFile?: string;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: string;
	status?: string;
	createdAt?: string;
	updatedAt?: string;
	[key: string]: unknown;
}

export interface MessagesPage {
	messages: unknown[];
	hasMore: boolean;
	/** Index of the first returned message in the full ordered list. */
	offset: number;
	total: number;
	source: "live" | "disk";
}

export interface CreateSessionRequest {
	cwd: string;
	provider?: string;
	model?: string;
	thinking?: string;
	name?: string;
	goal?: string;
	prompt?: string;
}

export interface CreateSessionResponse {
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
}

export interface ModelsResponse {
	models: Array<{ provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }>;
	source: "daemon" | "disk";
}

export interface SchedulesResponse {
	cron: unknown[];
	heartbeats: unknown[];
	offline: Array<{ sessionId: string; jobs: unknown[] }>;
}

export interface CommsResponse {
	records: AgentMessageRecord[];
	status?: AgentMessagesStatus;
}

export interface DeployRun {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	exitCode?: number;
	lines: string[];
	running: boolean;
}

export type ModelPodPhase = "absent" | "starting" | "downloading" | "ready" | "stopped" | "error";

export interface ModelPodStatus {
	phase: ModelPodPhase;
	podId?: string;
	url?: string;
	healthy: boolean;
	servedModel?: string;
	gpu?: string;
	cloud?: string;
	costPerHr?: number;
	createdAt?: string;
	everHealthy?: boolean;
	lastError?: string;
	note?: string;
}

/**
 * State of the one folder binding between the pod's /workspace and Eray's Mac.
 *
 * - `unbound`  no binding daemon has ever reported to this observer
 * - `syncing`  a pass is in flight (or the daemon has only just started)
 * - `healthy`  the last pass succeeded and the heartbeat is fresh
 * - `failing`  the daemon is reachable but rsync is erroring
 * - `stale`    nothing has been heard for longer than `staleAfterSec`
 */
export type BindingPhase = "unbound" | "syncing" | "healthy" | "failing" | "stale";

/** Reported by deploy/pod-bind.py on the Mac; every field is best-effort. */
export interface BindingHeartbeat {
	/** The single folder on the Mac that mirrors the volume. */
	dest: string;
	/** Path on the pod being mirrored, normally /workspace. */
	remote: string;
	host?: string;
	port?: number;
	podId?: string;
	activity: "syncing" | "idle";
	lastResult?: "ok" | "error";
	lastSyncAt?: string;
	lastSyncDurationMs?: number;
	filesTransferred?: number;
	bytesTransferred?: number;
	/** Size and file count of the local folder after the last pass. */
	localBytes?: number;
	localFiles?: number;
	consecutiveFailures?: number;
	error?: string;
	daemonStartedAt?: string;
	agent?: string;
}

export interface BindingStatus {
	phase: BindingPhase;
	/** Seconds since the last heartbeat landed; absent when none ever has. */
	ageSec?: number;
	lastHeartbeatAt?: string;
	staleAfterSec: number;
	expectedHeartbeatSec: number;
	heartbeat?: BindingHeartbeat;
	/** Heartbeats accepted since this observer started. */
	beats: number;
}

export interface ApiError {
	error: string;
	code?: string;
	[key: string]: unknown;
}

export type {
	AgentMessageRecord,
	AgentMessagesStatus,
	AgentNode,
	DaemonInfo,
	FleetTree,
	HarnessView,
	RefinementResult,
	SkillDoc,
	SkillSummary,
};

/** One place the conversation can be rewound to: a user message on the current branch. */
export interface RewindPoint {
	entryId: string;
	/** 0-based position among the branch's user messages, oldest first. */
	index: number;
	text: string;
	timestamp?: string | number;
	label?: string;
}

export interface RewindPointsResponse {
	points: RewindPoint[];
	leafId: string | null;
	activeSessionId: string;
}

export interface RewindRequest {
	entryId: string;
	/** Ask the model to summarize the abandoned branch into a note the agent keeps. */
	summarize?: boolean;
	/** Live id to use when the fleet has not yet noticed a just-resumed session. */
	activeSessionId?: string;
}

export interface RewindResponse {
	ok: true;
	cancelled: boolean;
	aborted?: boolean;
	/** The rewound-to user message, offered back into the composer so it can be re-asked. */
	editorText?: string;
	summarized: boolean;
}
