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
