import type { RewindPoint } from "../../shared/api.ts";

/** The subset of a session tree node the observer needs; the harness type is far wider. */
export interface FlatTreeNode {
	entry: {
		id: string;
		parentId?: string | null;
		type: string;
		timestamp?: string | number;
		message?: { role?: string; content?: unknown };
		content?: unknown;
	};
	label?: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.join("");
}

/**
 * The user messages on the branch that ends at `leafId`, oldest first. Walks parent pointers
 * from the leaf so entries on abandoned branches never show up: those are not points you can
 * "go back" to, they are points you already left. Each point navigates to just before that
 * message (the harness's navigate_tree semantics for a user entry), which is what "rewind to
 * here and re-ask" means.
 */
export function rewindPointsForBranch(flatNodes: FlatTreeNode[], leafId: string | null): RewindPoint[] {
	const byId = new Map(flatNodes.map((n) => [n.entry.id, n]));
	const path: FlatTreeNode[] = [];
	const seen = new Set<string>();
	let current = leafId ? byId.get(leafId) : undefined;
	while (current && !seen.has(current.entry.id)) {
		seen.add(current.entry.id);
		path.push(current);
		const parent = current.entry.parentId;
		current = parent ? byId.get(parent) : undefined;
	}
	path.reverse();
	const points: RewindPoint[] = [];
	for (const node of path) {
		const e = node.entry;
		if (e.type !== "message" || e.message?.role !== "user") continue;
		const text = textOf(e.message.content).trim();
		if (!text) continue;
		points.push({
			entryId: e.id,
			index: points.length,
			text: text.length > 600 ? `${text.slice(0, 600)}…` : text,
			timestamp: e.timestamp,
			label: node.label,
		});
	}
	return points;
}
