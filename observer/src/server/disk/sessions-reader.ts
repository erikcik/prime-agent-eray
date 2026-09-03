import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessageRecord } from "../../shared/comms.ts";
import type { RefinementResult } from "../../shared/harness.ts";
import { FileMemo, readFirstJsonLine, readJsonl } from "./jsonl.ts";
import { refinementFromSessionEntry } from "./harness-reader.ts";
import { normalizeModel, normalizeTime } from "./artifacts-reader.ts";
import { sessionIdFromFile } from "./paths.ts";

/** Session JSONL header (packages/coding-agent/docs/session-format.md). */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	rlmDepth?: number;
	git?: unknown;
	[key: string]: unknown;
}

export interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	childCost: number;
}

export interface SessionSummaryOnDisk {
	sessionId: string;
	sessionFile: string;
	header: SessionHeader | undefined;
	name?: string;
	cwd?: string;
	createdAt?: string;
	lastActivityAt?: string;
	messageCount: number;
	userMessageCount: number;
	toolCallCount: number;
	firstMessage?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	agentStatus?: { summary: string; taskState?: string; basedOnMessageCount?: number };
	goal?: unknown;
	usage: UsageTotals;
	agentMessages: AgentMessageRecord[];
	refinements: RefinementResult[];
	badLines: number;
	rlmDepth: number;
}

export interface ParsedSession {
	header: SessionHeader | undefined;
	entries: SessionEntry[];
	summary: SessionSummaryOnDisk;
	/** Ordered path root→leaf of `message` entries (current branch). */
	messages: unknown[];
}

const memo = new FileMemo<ParsedSession>(async (path) => parseSessionFile(path));

export function readSession(path: string): Promise<ParsedSession> {
	return memo.get(path);
}

export function invalidateSession(path?: string): void {
	memo.invalidate(path);
}

export async function readSessionHeader(path: string): Promise<SessionHeader | undefined> {
	const first = await readFirstJsonLine<SessionHeader>(path);
	return first?.type === "session" ? first : undefined;
}

export async function listRootSessionFiles(sessionsDir: string): Promise<string[]> {
	try {
		const names = await readdir(sessionsDir);
		return names.filter((n) => n.endsWith(".jsonl")).map((n) => join(sessionsDir, n));
	} catch {
		return [];
	}
}

export async function parseSessionFile(path: string): Promise<ParsedSession> {
	const { entries: raw, badLines } = await readJsonl<Record<string, unknown>>(path);
	const header = raw[0]?.type === "session" ? (raw[0] as unknown as SessionHeader) : undefined;
	const entries = (header ? raw.slice(1) : raw).filter(
		(e): e is SessionEntry & Record<string, unknown> => !!e && typeof e.type === "string" && typeof e.id === "string",
	) as SessionEntry[];
	const sessionId = header?.id ?? sessionIdFromFile(path);
	const summary = summarize(entries, header, path, sessionId, badLines);
	const messages = branchMessages(entries);
	return { header, entries, summary, messages };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	return "";
}

function summarize(entries: SessionEntry[], header: SessionHeader | undefined, path: string, sessionId: string, badLines: number): SessionSummaryOnDisk {
	const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, childCost: 0 };
	const s: SessionSummaryOnDisk = {
		sessionId,
		sessionFile: path,
		header,
		cwd: header?.cwd,
		createdAt: header?.timestamp,
		messageCount: 0,
		userMessageCount: 0,
		toolCallCount: 0,
		usage,
		agentMessages: [],
		refinements: [],
		badLines,
		rlmDepth: typeof header?.rlmDepth === "number" ? header.rlmDepth : 0,
	};
	for (const e of entries) {
		if (typeof e.timestamp === "string") s.lastActivityAt = e.timestamp;
		switch (e.type) {
			case "message": {
				const m = e.message as Record<string, unknown> | undefined;
				if (!m) break;
				s.messageCount++;
				const role = m.role;
				if (role === "user") {
					s.userMessageCount++;
					if (!s.firstMessage) s.firstMessage = textOf(m.content).slice(0, 200);
				} else if (role === "assistant") {
					if (typeof m.model === "string") s.model = m.model;
					if (typeof m.provider === "string") s.provider = m.provider;
					const u = m.usage as Record<string, unknown> | undefined;
					if (u) {
						usage.input += num(u.input);
						usage.output += num(u.output);
						usage.cacheRead += num(u.cacheRead);
						usage.cacheWrite += num(u.cacheWrite);
						usage.total += num(u.totalTokens);
						usage.cost += num((u.cost as Record<string, unknown> | undefined)?.total);
					}
					if (Array.isArray(m.content)) {
						s.toolCallCount += m.content.filter((p) => (p as { type?: string })?.type === "toolCall").length;
					}
				}
				break;
			}
			case "model_change":
				if (typeof e.modelId === "string") s.model = e.modelId;
				if (typeof e.provider === "string") s.provider = e.provider;
				break;
			case "thinking_level_change":
				if (typeof e.thinkingLevel === "string") s.thinkingLevel = e.thinkingLevel;
				break;
			case "session_info":
				if (typeof e.name === "string") s.name = e.name;
				break;
			case "agent_status": {
				const st = e.status as { summary?: unknown; taskState?: unknown; basedOnMessageCount?: unknown } | undefined;
				if (st && typeof st.summary === "string") {
					s.agentStatus = {
						summary: st.summary,
						taskState: typeof st.taskState === "string" ? st.taskState : undefined,
						basedOnMessageCount: typeof st.basedOnMessageCount === "number" ? st.basedOnMessageCount : undefined,
					};
				}
				break;
			}
			case "child_usage_attributed": {
				const cu = e.childUsage as Record<string, unknown> | undefined;
				usage.childCost += num((cu?.cost as Record<string, unknown> | undefined)?.total);
				break;
			}
			case "custom": {
				if (e.customType === "thread_goal_state") s.goal = e.data;
				const r = refinementFromSessionEntry(e, path, sessionId);
				if (r) s.refinements.push(r);
				break;
			}
			case "custom_message": {
				if (e.customType === "agent_message") {
					const rec = agentMessageFromEntry(e, path, sessionId);
					if (rec) s.agentMessages.push(rec);
				}
				break;
			}
			default:
				break;
		}
	}
	return s;
}

export function agentMessageFromEntry(e: SessionEntry, sessionFile: string, ownerSessionId: string): AgentMessageRecord | undefined {
	const d = (e.details ?? {}) as Record<string, unknown>;
	const from = (d.from ?? {}) as Record<string, unknown>;
	const target = (d.target ?? {}) as Record<string, unknown>;
	const text = typeof d.message === "string" ? d.message : textOf(e.content);
	const endpoint = (x: Record<string, unknown>) => ({
		sessionId: str(x.sessionId),
		activeSessionId: str(x.activeSessionId),
		sessionName: str(x.sessionName),
		runtimeKind: str(x.runtimeKind),
		clientId: str(x.clientId),
	});
	return {
		id: typeof d.id === "string" ? d.id : e.id,
		at: e.timestamp,
		text,
		from: endpoint(from),
		to: Object.keys(target).length ? endpoint(target) : { sessionId: ownerSessionId },
		relationship: str(d.fromRelationship),
		direction: "received",
		sourceFile: sessionFile,
		ownerSessionId,
	};
}

/** Follow the current branch: walk from the last entry up through parentId to the root, keep `message` entries. */
export function branchMessages(entries: SessionEntry[]): unknown[] {
	if (entries.length === 0) return [];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const leaf = entries[entries.length - 1];
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let cur: SessionEntry | undefined = leaf;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		path.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	path.reverse();
	return path.filter((e) => e.type === "message").map((e) => e.message);
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export { normalizeModel, normalizeTime };
