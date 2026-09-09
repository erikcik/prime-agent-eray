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
