import type { AgentMessageRecord, AgentMessagesStatus } from "./comms.ts";
import type { AgentNode, DaemonInfo, FleetTree } from "./fleet.ts";

export const WS_PROTOCOL = "prime-observer.v1";
export const WS_BEARER_PREFIX = "bearer.";

export type Topic =
	| "daemon"
	| "fleet"
	| "harness"
	| "schedules"
	| "comms"
	| "deploy"
	| "uploads"
	| `session:${string}`;

export type ClientMessage =
	| { t: "auth"; token: string }
	| { t: "sub"; topics: Topic[] }
	| { t: "unsub"; topics: Topic[] }
	| { t: "ping" };

export type ServerMessage =
	| { t: "hello"; serverStartedAt: string; version: string }
	| { t: "pong" }
	| { t: "error"; message: string; code?: string }
	| { t: "daemon.state"; daemon: DaemonInfo }
	| { t: "fleet.snapshot"; tree: FleetTree }
	| { t: "fleet.patch"; changed: AgentNode[]; removed: string[] }
	| { t: "session.snapshot"; activeSessionId: string; snapshot: unknown }
	| { t: "session.event"; activeSessionId: string; event: unknown }
	| { t: "session.status"; activeSessionId: string; recap?: unknown }
	| { t: "session.connection"; activeSessionId: string; status: unknown }
	| { t: "session.children"; activeSessionId: string; children: unknown[] }
	| { t: "session.closed"; activeSessionId: string; reason?: string }
	| { t: "session.remapped"; sessionId: string; activeSessionId: string }
	| { t: "session.resync_required"; activeSessionId: string }
	| { t: "harness.changed"; scope: "global" | "local"; sessionId?: string }
	| { t: "uploads.changed"; cwd: string }
	| { t: "schedules.changed" }
	| { t: "comms.message"; record: AgentMessageRecord }
	| { t: "comms.status"; status: AgentMessagesStatus }
	| { t: "deploy.started"; runId: string }
	| { t: "deploy.log"; runId: string; line: string; stream: "out" | "err"; at: string }
	| { t: "deploy.done"; runId: string; exitCode: number; willRestart: boolean };

export function isSessionTopic(topic: string): topic is `session:${string}` {
	return topic.startsWith("session:");
}

// ---- terminal (the real prime-agent TUI over a PTY) ----------------------------------------
export const TERM_WS_PATH = "/ws/term";
export const TERM_WS_PROTOCOL = "prime-observer-term.v1";

/** Client → server on the terminal socket. Output flows back as raw binary frames. */
export type TermClientMessage =
	| { t: "auth"; token: string }
	| { t: "open"; cols: number; rows: number }
	| { t: "in"; data: string }
	| { t: "resize"; cols: number; rows: number };

export type TermServerMessage =
	| { t: "hello" }
	| { t: "ready"; pid: number; cols: number; rows: number }
	| { t: "exit"; code: number; signal?: number }
	| { t: "error"; message: string; code?: string };
