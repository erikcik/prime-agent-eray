import type { DaemonClient, SessionSummary } from "@earendil-works/pi-coding-agent";
import { logger } from "../log.ts";

/** Structural copy of packages/coding-agent/src/modes/daemon/agent-roster.ts AgentRosterEntry. */
export interface RosterEntry {
	agentId: string;
	queuedChild?: true;
	seededCwd?: true;
	summary: Omit<SessionSummary, "streamingMessage" | "sessionActions" | "diagnostics">;
	status: string;
	statusLabel?: "queued" | "recovering" | "failed";
	lastHeardFromAt?: string;
	workerId?: string;
}

type RosterUpdate = { type: "roster_update"; changed: RosterEntry[]; removed?: string[]; resync?: true };

/**
 * Read-only fleet roster mirror. Port of the harness's AgentsViewRosterStore
 * (packages/coding-agent/src/modes/agents-view/roster-store.ts): roster_subscribe + buffered
 * roster_update pushes, with a `list` polling fallback when the daemon lacks `agent_roster`.
 */
export class RosterStore {
	private readonly entries = new Map<string, RosterEntry>();
	private readonly listeners = new Set<() => void>();
	private client: DaemonClient | undefined;
	private unsubscribeMessage: (() => void) | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private emitScheduled = false;
	private chain: Promise<unknown> = Promise.resolve();
	private log = logger("roster");
	private mode: "push" | "poll" | "detached" = "detached";

	get sourceMode(): "push" | "poll" | "detached" {
		return this.mode;
	}

	async attach(client: DaemonClient): Promise<void> {
		const run = () => this.attachNow(client);
		const chained = this.chain.then(run, run);
		this.chain = chained;
		return chained;
	}

	private async attachNow(client: DaemonClient): Promise<void> {
		this.detach();
		this.client = client;
		if (!client.supportsServerCapability("agent_roster" as never)) {
			this.mode = "poll";
			this.log.warn("daemon lacks agent_roster; falling back to list polling");
			await this.pollOnce();
			this.pollTimer = setInterval(() => void this.pollOnce(), 3000);
			return;
		}
		let pending: RosterUpdate[] | undefined = [];
		this.unsubscribeMessage = client.onMessage((message) => {
			if ((message as { type: string }).type !== "roster_update") return;
			const update = message as unknown as RosterUpdate;
			if (pending) pending.push(update);
			else this.apply(update.changed, update.removed, update.resync);
		});
		let response: Awaited<ReturnType<DaemonClient["request"]>>;
		try {
			response = await client.request({ type: "roster_subscribe" } as never, 30000, { recoverable: false } as never);
		} catch (error) {
			this.detach();
			throw error;
		}
		if (!response.success || typeof response.data !== "object" || response.data === null) {
			this.detach();
			throw new Error(`roster_subscribe failed: ${response.success ? "invalid payload" : response.error ?? "unknown"}`);
		}
		const roster = (response.data as { roster?: RosterEntry[] }).roster ?? [];
		this.apply(roster, undefined, true);
		for (const u of pending) this.apply(u.changed, u.removed, u.resync);
		pending = undefined;
		this.mode = "push";
	}

	private async pollOnce(): Promise<void> {
		const client = this.client;
		if (!client?.isConnected) return;
		try {
			const res = await client.request({ type: "list" } as never, 15000);
			if (!res.success) return;
			const sessions = ((res.data as { sessions?: SessionSummary[] }).sessions ?? []).filter(
				(s) => s.activeSessionId,
			);
			const entries: RosterEntry[] = sessions.map((s) => {
				const { streamingMessage: _s, sessionActions: _a, diagnostics: _d, ...slim } = s;
				return {
					agentId: rosterAgentId(s),
					summary: slim,
					status: s.rosterStatus ?? (s.activity === "working" ? "running" : "idle"),
					statusLabel: s.statusLabel,
				};
			});
			this.apply(entries, undefined, true);
		} catch (e) {
			this.log.debug("list poll failed", e);
		}
	}

	private apply(changed: RosterEntry[], removed?: string[], resync?: true): void {
		if (resync) this.entries.clear();
		for (const e of changed) this.entries.set(e.agentId, e);
		for (const id of removed ?? []) this.entries.delete(id);
		this.scheduleEmit();
	}

	all(): RosterEntry[] {
		return [...this.entries.values()];
	}

	byActiveSessionId(activeSessionId: string): RosterEntry | undefined {
		for (const e of this.entries.values()) if (e.summary.activeSessionId === activeSessionId) return e;
		return undefined;
	}

	bySessionId(sessionId: string): RosterEntry | undefined {
		for (const e of this.entries.values()) if (e.summary.sessionId === sessionId) return e;
		return undefined;
	}

	onUpdate(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private scheduleEmit(): void {
		if (this.emitScheduled) return;
		this.emitScheduled = true;
		queueMicrotask(() => {
			this.emitScheduled = false;
			for (const l of [...this.listeners]) {
				try {
					l();
				} catch {
					// keep delivering
				}
			}
		});
	}

	detach(): void {
		this.unsubscribeMessage?.();
		this.unsubscribeMessage = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		const client = this.client;
		this.client = undefined;
		if (this.mode === "push" && client?.isConnected) {
			void client.request({ type: "roster_unsubscribe" } as never).catch(() => undefined);
		}
		this.mode = "detached";
	}

	/** Called on daemon disconnect: keep nothing, the daemon is the only truth for live entries. */
	clear(): void {
		this.detach();
		if (this.entries.size) {
			this.entries.clear();
			this.scheduleEmit();
		}
	}
}

/** Same keying as agent-roster.ts rosterAgentIdForSummary(). */
export function rosterAgentId(s: Pick<SessionSummary, "runtimeKind" | "rlmChildId" | "sessionId" | "parentSessionPath" | "parentActiveSessionId">): string {
	if (s.runtimeKind === "subagent" && s.rlmChildId) {
		const parentKey = s.parentSessionPath ?? s.parentActiveSessionId;
		return parentKey ? `${parentKey}#${s.rlmChildId}` : s.rlmChildId;
	}
	return s.sessionId;
}
