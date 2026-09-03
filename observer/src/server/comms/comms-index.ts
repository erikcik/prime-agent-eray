import type { AgentMessageRecord } from "../../shared/comms.ts";
import { readSession } from "../disk/sessions-reader.ts";

/**
 * Agent-to-agent messages across every known session file (roots + subagents), plus live
 * `ipython_sent_agent_message` events observed while streaming.
 */
export class CommsIndex {
	private live: AgentMessageRecord[] = [];
	private listeners = new Set<(r: AgentMessageRecord) => void>();

	async collect(sessionFiles: Iterable<string>, limit = 500): Promise<AgentMessageRecord[]> {
		const out: AgentMessageRecord[] = [...this.live];
		for (const file of sessionFiles) {
			try {
				const parsed = await readSession(file);
				out.push(...parsed.summary.agentMessages);
			} catch {
				// unreadable file: skip
			}
		}
		const seen = new Set<string>();
		const dedup = out.filter((r) => {
			const k = `${r.id}|${r.direction}|${r.ownerSessionId}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		dedup.sort((a, b) => b.at.localeCompare(a.at));
		return dedup.slice(0, limit);
	}

	/** From a live `ipython_sent_agent_message` session event. */
	recordSent(ownerSessionId: string, ownerActiveSessionId: string | undefined, message: Record<string, unknown>, at = new Date().toISOString()): AgentMessageRecord {
		const target = (message.target ?? message.receiver ?? {}) as Record<string, unknown>;
		const rec: AgentMessageRecord = {
			id: typeof message.id === "string" ? message.id : `${ownerSessionId}:${at}`,
			at,
			text: typeof message.message === "string" ? message.message : typeof message.text === "string" ? message.text : JSON.stringify(message),
			from: { sessionId: ownerSessionId, activeSessionId: ownerActiveSessionId },
			to: {
				sessionId: typeof target.sessionId === "string" ? target.sessionId : undefined,
				activeSessionId: typeof target.activeSessionId === "string" ? target.activeSessionId : undefined,
				sessionName: typeof target.sessionName === "string" ? target.sessionName : typeof message.receiver_name === "string" ? message.receiver_name : undefined,
			},
			relationship: typeof message.receiver_role === "string" ? message.receiver_role : undefined,
			direction: "sent",
			sourceFile: "live",
			ownerSessionId,
		};
		this.live.unshift(rec);
		if (this.live.length > 1000) this.live.length = 1000;
		for (const l of [...this.listeners]) l(rec);
		return rec;
	}

	onRecord(listener: (r: AgentMessageRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
