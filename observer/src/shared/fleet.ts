// Fleet model shared by server and web. Built from the daemon roster + on-disk ledger/sessions.

export type AgentStatus =
	| "running"
	| "needs_input"
	| "idle"
	| "inactive"
	| "queued"
	| "recovering"
	| "failed"
	| "deleted";

export type RuntimeKind = "top-level" | "subagent";

export interface AgentNode {
	/** Stable key: sessionFile for roots, `${parentSessionFile}#${childId}` for subagents. */
	key: string;
	sessionId: string;
	/** Present only while the daemon hosts the session. */
	activeSessionId?: string;
	sessionFile?: string;
	name?: string;
	cwd?: string;
	status: AgentStatus;
	runtimeKind: RuntimeKind;
	depth: number;
	childId?: string;
	parentKey?: string;
	model?: string;
	provider?: string;
	recap?: string;
	taskState?: "needs_input" | "completed";
	firstMessage?: string;
	messageCount: number;
	createdAt?: string;
	lastActivityAt?: string;
	isStreaming: boolean;
	isRunningTools: boolean;
	hasHeartbeat: boolean;
	hasSchedules: boolean;
	spawnCode?: string;
	prompt?: string;
	tokens?: { input: number; output: number; cacheRead: number; total: number; cost?: number };
	children: AgentNode[];
}

export interface FleetCounts {
	running: number;
	needsInput: number;
	idle: number;
	inactive: number;
	failed: number;
	subagents: number;
	total: number;
}

export interface FleetTree {
	roots: AgentNode[];
	counts: FleetCounts;
	generatedAt: string;
	/** Whether the daemon roster contributed (false = disk-only view). */
	live: boolean;
}

export interface DaemonInfo {
	state: "offline" | "connecting" | "online" | "stale";
	socketPath: string;
	appVersion?: string;
	protocolVersion?: number;
	capabilities?: string[];
	supervisorGeneration?: number;
	pid?: number;
	lastError?: string;
	since?: string;
}
