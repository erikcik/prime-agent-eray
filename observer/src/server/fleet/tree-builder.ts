import type { AgentNode, AgentStatus, FleetCounts, FleetTree } from "../../shared/fleet.ts";
import type { RosterEntry } from "../daemon/roster-store.ts";
import type { LedgerEdge } from "../disk/ledger-reader.ts";
import type { SessionSummaryOnDisk } from "../disk/sessions-reader.ts";

export interface TreeInputs {
	roster: RosterEntry[];
	edges: LedgerEdge[];
	/** Disk summaries keyed by session file (roots and children). */
	disk: Map<string, SessionSummaryOnDisk>;
	live: boolean;
	now?: Date;
}

/**
 * Pure: roster (live truth) + ledger edges (topology incl. dead children) + disk summaries
 * (history) -> a tree of AgentNodes. Keys: roots by session file, children by `${parentFile}#${childId}`.
 */
export function buildFleetTree(inputs: TreeInputs): FleetTree {
	const nodes = new Map<string, AgentNode>();
	const parentOf = new Map<string, string>();

	const nodeForFile = (file: string, depth: number, childId?: string, parentFile?: string): AgentNode => {
		const key = childId && parentFile ? `${parentFile}#${childId}` : file;
		let n = nodes.get(key);
		if (n) return n;
		const d = inputs.disk.get(file);
		n = {
			key,
			sessionId: d?.sessionId ?? sessionIdFromFile(file),
			sessionFile: file,
			name: d?.name,
			cwd: d?.cwd,
			status: "inactive",
			runtimeKind: childId ? "subagent" : "top-level",
			depth,
			childId,
			parentKey: parentFile ? nodes.get(parentFile)?.key ?? parentFile : undefined,
			model: d?.model && d.provider ? `${d.provider}/${d.model}` : d?.model,
			provider: d?.provider,
			recap: d?.agentStatus?.summary,
			taskState: d?.agentStatus?.taskState as AgentNode["taskState"],
			firstMessage: d?.firstMessage,
			messageCount: d?.messageCount ?? 0,
			createdAt: d?.createdAt,
			lastActivityAt: d?.lastActivityAt,
			isStreaming: false,
			isRunningTools: false,
			hasHeartbeat: false,
			hasSchedules: false,
			tokens: d
				? { input: d.usage.input, output: d.usage.output, cacheRead: d.usage.cacheRead, total: d.usage.total, cost: d.usage.cost + d.usage.childCost }
				: undefined,
			children: [],
		};
		nodes.set(key, n);
		if (parentFile) parentOf.set(key, parentFile);
		return n;
	};

	// 1. Roots from disk.
	for (const [file, d] of inputs.disk) {
		if (d.rlmDepth === 0 && !file.includes("/session-artifacts/")) nodeForFile(file, 0);
	}
	// 2. Children from the ledger (dead ones included).
	const sortedEdges = [...inputs.edges].sort((a, b) => a.depth - b.depth || a.spawnedAt.localeCompare(b.spawnedAt));
	for (const e of sortedEdges) {
		if (!nodes.has(e.parentFile) && !inputs.disk.has(e.parentFile)) {
			// Parent unknown on disk (deleted?) — still show it as a stub root.
			nodeForFile(e.parentFile, 0);
		}
		const parent = findNodeByFile(nodes, e.parentFile);
		const child = nodeForFile(e.childFile, (parent?.depth ?? 0) + 1, e.childId, e.parentFile);
		child.parentKey = parent?.key ?? e.parentFile;
		child.name = child.name ?? e.name;
		child.createdAt = child.createdAt ?? e.spawnedAt;
		if (e.deleted) child.status = "deleted";
	}
	// 3. Overlay live roster.
	for (const r of inputs.roster) {
		const s = r.summary;
		let node: AgentNode | undefined;
		if (s.runtimeKind === "subagent" && s.rlmChildId && s.parentSessionPath) {
			node = nodes.get(`${s.parentSessionPath}#${s.rlmChildId}`);
			if (!node && s.sessionFile) node = nodeForFile(s.sessionFile, (s.rlmDepth ?? 1), s.rlmChildId, s.parentSessionPath);
		} else if (s.sessionFile) {
			node = findNodeByFile(nodes, s.sessionFile) ?? nodeForFile(s.sessionFile, s.rlmDepth ?? 0);
		}
		if (!node) {
			// --no-session or not yet persisted: synthesize a live-only node.
			node = {
				key: r.agentId,
				sessionId: s.sessionId,
				status: "idle",
				runtimeKind: s.runtimeKind ?? "top-level",
				depth: s.rlmDepth ?? 0,
				childId: s.rlmChildId,
				messageCount: 0,
				isStreaming: false,
				isRunningTools: false,
				hasHeartbeat: false,
				hasSchedules: false,
				children: [],
			};
			nodes.set(node.key, node);
		}
		node.activeSessionId = s.activeSessionId;
		node.name = s.sessionName ?? node.name;
		node.cwd = s.cwd ?? node.cwd;
		const model = s.model as { provider?: string; id?: string } | undefined;
		if (model?.id) {
			node.model = model.provider ? `${model.provider}/${model.id}` : model.id;
			node.provider = model.provider;
		}
		node.recap = s.summary ?? node.recap;
		node.taskState = (s.taskState as AgentNode["taskState"]) ?? node.taskState;
		node.firstMessage = s.firstMessage ?? node.firstMessage;
		node.messageCount = Math.max(node.messageCount, s.messageCount ?? 0);
		node.lastActivityAt = s.lastActivityAt ?? s.modified ?? node.lastActivityAt;
		node.createdAt = node.createdAt ?? s.created;
		node.isStreaming = s.isStreaming === true;
		node.isRunningTools = s.isRunningTools === true;
		node.hasHeartbeat = s.hasActiveHeartbeat === true || s.hasRegisteredHeartbeat === true;
		node.hasSchedules = s.hasRegisteredCronJob === true;
		node.spawnCode = s.spawnCode ?? node.spawnCode;
		node.status = liveStatus(r);
	}
	// 4. Assemble tree.
	const roots: AgentNode[] = [];
	for (const n of nodes.values()) {
		const parentKey = n.parentKey;
		const parent = parentKey ? nodes.get(parentKey) ?? findNodeByFile(nodes, parentKey) : undefined;
		if (parent && parent !== n) parent.children.push(n);
		else roots.push(n);
	}
	const byRecent = (a: AgentNode, b: AgentNode) => (b.lastActivityAt ?? b.createdAt ?? "").localeCompare(a.lastActivityAt ?? a.createdAt ?? "");
	const rank = (n: AgentNode) => STATUS_RANK[n.status];
	const sortRec = (list: AgentNode[]) => {
		list.sort((a, b) => rank(a) - rank(b) || byRecent(a, b));
		for (const n of list) sortRec(n.children);
	};
	sortRec(roots);
	const counts = countNodes(nodes.values());
	return { roots, counts, generatedAt: (inputs.now ?? new Date()).toISOString(), live: inputs.live };
}

const STATUS_RANK: Record<AgentStatus, number> = {
	running: 0,
	needs_input: 1,
	queued: 2,
	recovering: 2,
	idle: 3,
	failed: 4,
	inactive: 5,
	deleted: 6,
};

function liveStatus(r: RosterEntry): AgentStatus {
	if (r.statusLabel === "failed") return "failed";
	if (r.statusLabel === "queued" || r.queuedChild) return "queued";
	if (r.statusLabel === "recovering") return "recovering";
	const s = r.summary;
	if (s.taskState === "needs_input") return "needs_input";
	if (s.activity === "working" || s.isStreaming || s.hasRunningRlmChildren) return "running";
	if (r.status === "running" || r.status === "active") return "running";
	if (!s.activeSessionId) return "inactive";
	return "idle";
}

function countNodes(all: Iterable<AgentNode>): FleetCounts {
	const c: FleetCounts = { running: 0, needsInput: 0, idle: 0, inactive: 0, failed: 0, subagents: 0, total: 0 };
	for (const n of all) {
		c.total++;
		if (n.runtimeKind === "subagent") c.subagents++;
		switch (n.status) {
			case "running":
			case "queued":
			case "recovering":
				c.running++;
				break;
			case "needs_input":
				c.needsInput++;
				break;
			case "idle":
				c.idle++;
				break;
			case "failed":
				c.failed++;
				break;
			default:
				c.inactive++;
		}
	}
	return c;
}

function findNodeByFile(nodes: Map<string, AgentNode>, file: string): AgentNode | undefined {
	const direct = nodes.get(file);
	if (direct) return direct;
	for (const n of nodes.values()) if (n.sessionFile === file) return n;
	return undefined;
}

function sessionIdFromFile(file: string): string {
	const base = file.split("/").pop() ?? file;
	return base.replace(/\.jsonl$/, "");
}

export function flattenTree(tree: FleetTree): AgentNode[] {
	const out: AgentNode[] = [];
	const walk = (list: AgentNode[]) => {
		for (const n of list) {
			out.push(n);
			walk(n.children);
		}
	};
	walk(tree.roots);
	return out;
}
