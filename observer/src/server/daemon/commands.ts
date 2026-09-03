import type { AgentSessionRuntimeConfig, DaemonClient, SessionSummary } from "@earendil-works/pi-coding-agent";
import type { DaemonBridge } from "./bridge.ts";

export class DaemonCommandError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly status = 502,
	) {
		super(message);
	}
}

/**
 * Thin typed wrappers over DaemonClient.request for every daemon command the observer uses
 * (packages/coding-agent/src/modes/daemon/daemon-protocol.ts). Commands are sent as plain
 * objects; the harness validates them and reports capability gaps in its error string.
 */
export class DaemonCommands {
	constructor(private readonly bridge: DaemonBridge) {}

	private client(): DaemonClient {
		return this.bridge.requireClient();
	}

	async send<T = unknown>(command: Record<string, unknown>, timeoutMs = 30000, onProgress?: (p: unknown) => void): Promise<T> {
		const client = this.client();
		let res: Awaited<ReturnType<DaemonClient["request"]>>;
		try {
			res = await client.request(command as never, timeoutMs, (onProgress ? { onProgress } : {}) as never);
		} catch (e) {
			throw new DaemonCommandError(e instanceof Error ? e.message : String(e), "daemon_request_failed");
		}
		if (!res.success) {
			const info = (res as { errorInfo?: { code?: string } }).errorInfo;
			throw new DaemonCommandError(res.error ?? `daemon command ${String(command.type)} failed`, info?.code, 502);
		}
		return res.data as T;
	}

	list(all = false): Promise<{ sessions: SessionSummary[] }> {
		return this.send({ type: "list", all, includeClientOwned: true }, 20000);
	}

	create(options: {
		cwd: string;
		provider?: string;
		model?: string;
		thinking?: string;
		name?: string;
		initialGoal?: { objective: string; tokenBudget?: number };
		sessionPath?: string;
	}): Promise<SessionSummary> {
		const config: AgentSessionRuntimeConfig = { cwd: options.cwd };
		if (options.provider) config.provider = options.provider;
		if (options.model) config.model = options.model;
		if (options.thinking) config.thinking = options.thinking as AgentSessionRuntimeConfig["thinking"];
		if (options.initialGoal) config.initialGoal = options.initialGoal;
		const cmd: Record<string, unknown> = { type: "create", config };
		if (options.name) cmd.name = options.name;
		if (options.sessionPath) cmd.sessionPath = options.sessionPath;
		return this.send<SessionSummary>(cmd, 60000);
	}

	prompt(activeSessionId: string, message: string, opts?: { streamingBehavior?: "steer" | "followUp"; queueIfBusy?: boolean }) {
		return this.send({ type: "prompt", activeSessionId, message, ...(opts ?? {}) }, 30000);
	}

	steer(activeSessionId: string, message: string) {
		return this.send({ type: "steer", activeSessionId, message });
	}

	followUp(activeSessionId: string, message: string) {
		return this.send({ type: "follow_up", activeSessionId, message });
	}

	abort(activeSessionId: string) {
		return this.send({ type: "abort", activeSessionId });
	}

	kill(activeSessionId: string) {
		return this.send({ type: "kill", activeSessionId });
	}

	sendMessage(activeSessionId: string, targetActiveSessionId: string, message: string) {
		return this.send({ type: "send_message", activeSessionId, targetActiveSessionId, message });
	}

	refine(activeSessionId: string, opts: { instructions?: string; rollbackId?: string; global?: boolean }) {
		return this.send({ type: "refine", activeSessionId, ...opts }, 180000);
	}

	exportHtml(activeSessionId: string, outputPath: string): Promise<{ path: string }> {
		return this.send({ type: "export_html", activeSessionId, outputPath }, 60000);
	}

	getState(activeSessionId: string) {
		return this.send({ type: "get_state", activeSessionId });
	}

	getMessages(activeSessionId: string) {
		return this.send<{ messages: unknown[] }>({ type: "get_messages", activeSessionId }, 60000);
	}

	getRlmChildren(activeSessionId: string) {
		return this.send<{ children: unknown[] }>({ type: "get_rlm_children", activeSessionId });
	}

	getSessionStats(activeSessionId: string) {
		return this.send({ type: "get_session_stats", activeSessionId });
	}

	getContextTree(activeSessionId: string) {
		return this.send({ type: "get_context_tree", activeSessionId });
	}

	getQueue(activeSessionId: string) {
		return this.send({ type: "get_queue", activeSessionId });
	}

	getAvailableModels(activeSessionId: string) {
		return this.send<{ models: unknown[] }>({ type: "get_available_models", activeSessionId });
	}

	cronList(activeSessionId?: string, includeInactive = true) {
		return this.send<{ jobs: unknown[] }>({ type: "cron_list", activeSessionId, includeInactive });
	}

	heartbeatsList() {
		return this.send<{ heartbeats: unknown[] }>({ type: "heartbeats_list" });
	}

	agentMessagesStatus(activeSessionId: string) {
		return this.send({ type: "agent_messages_status", activeSessionId });
	}

	restartDaemon() {
		return this.send({ type: "restart" }, 60000);
	}

	shutdownDaemon(force = false) {
		return this.send({ type: "shutdown", force }, 60000);
	}
}
