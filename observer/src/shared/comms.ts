export interface AgentEndpoint {
	sessionId?: string;
	activeSessionId?: string;
	sessionName?: string;
	runtimeKind?: string;
	clientId?: string;
}

export interface AgentMessageRecord {
	id: string;
	at: string;
	text: string;
	from: AgentEndpoint;
	to: AgentEndpoint;
	relationship?: string;
	direction: "received" | "sent" | "unknown";
	sourceFile: string;
	/** Session the record was read from. */
	ownerSessionId: string;
}

export interface AgentMessagesStatus {
	paused?: boolean;
	pendingCount?: number;
	[key: string]: unknown;
}
