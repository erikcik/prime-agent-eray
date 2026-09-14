import type { TimelineEntry } from "../../shared/bench.ts";
import type { SessionEntry, SessionHeader } from "../disk/sessions-reader.ts";

/**
 * Pure session surgery for checkpoint benchmarks. A snapshot is the current branch of a session
 * cut at an anchor entry, written as a standalone session file the harness can `--fork`.
 */

/** Daemon bookkeeping that must not travel into a fresh fork (lifecycle, status, git probes, usage folding). */
const DROP_TYPES = new Set(["session_state", "agent_status", "git_state", "child_usage_attributed"]);

export class SnapshotError extends Error {}

/** Root→target path (inclusive) following parentId. */
export function pathToEntry(entries: SessionEntry[], targetId: string): SessionEntry[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const target = byId.get(targetId);
	if (!target) throw new SnapshotError(`entry ${targetId} is not in the session`);
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let cur: SessionEntry | undefined = target;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		path.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return path.reverse();
}

/** Current branch = path from the root to the last entry in file order. */
export function currentBranch(entries: SessionEntry[]): SessionEntry[] {
	if (entries.length === 0) return [];
	return pathToEntry(entries, entries[entries.length - 1]!.id);
}

function messageOf(e: SessionEntry): Record<string, unknown> | undefined {
	return e.type === "message" && e.message && typeof e.message === "object" ? (e.message as Record<string, unknown>) : undefined;
}

export function isUserMessage(e: SessionEntry): boolean {
	return messageOf(e)?.role === "user";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => {
			if (!p || typeof p !== "object") return "";
			const part = p as Record<string, unknown>;
			if (part.type === "text") return String(part.text ?? "");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function imageCount(content: unknown): number {
	return Array.isArray(content) ? content.filter((p) => (p as { type?: string } | null)?.type === "image").length : 0;
}

export interface CutResult {
	cut: "before-user-message" | "mid-turn";
	anchor: SessionEntry;
	/** Entries kept in the snapshot, root first. */
	kept: SessionEntry[];
	/** The anchor user message text when cutting before it. */
	prompt?: string;
}

export function resolveCut(entries: SessionEntry[], anchorId: string): CutResult {
	const path = pathToEntry(entries, anchorId);
	const anchor = path[path.length - 1]!;
	if (isUserMessage(anchor)) {
		return { cut: "before-user-message", anchor, kept: path.slice(0, -1), prompt: contentText(messageOf(anchor)?.content) };
	}
	return { cut: "mid-turn", anchor, kept: path };
}

/** Serialize a cut as a session file. Parent links stay intact because every kept entry's parent is kept too. */
export function buildSnapshotFile(header: SessionHeader | undefined, kept: SessionEntry[], newSessionId: string, cwd: string): string {
	const base: Record<string, unknown> = header ? { ...header } : { type: "session", version: 3 };
	delete base.parentSession;
	const outHeader = { ...base, type: "session", id: newSessionId, timestamp: new Date().toISOString(), cwd };
	const lines = [JSON.stringify(outHeader)];
	for (const e of kept) {
		if (!DROP_TYPES.has(e.type)) lines.push(JSON.stringify(e));
	}
	// A dropped bookkeeping entry may sit between two kept ones; re-parent across it.
	return relinkAcrossDropped(lines, kept);
}

function relinkAcrossDropped(lines: string[], kept: SessionEntry[]): string {
	const byId = new Map(kept.map((e) => [e.id, e]));
	const out: string[] = [lines[0]!];
	for (const raw of lines.slice(1)) {
		const e = JSON.parse(raw) as SessionEntry;
		let parent = e.parentId ? byId.get(e.parentId) : undefined;
		while (parent && DROP_TYPES.has(parent.type)) parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		e.parentId = parent ? parent.id : null;
		out.push(JSON.stringify(e));
	}
	return `${out.join("\n")}\n`;
}

export function countMessages(entries: SessionEntry[]): number {
	return entries.filter((e) => e.type === "message").length;
}

/** Flatten a branch into readable rows for the UI and for helper-agent prompts. */
export function toTimeline(path: SessionEntry[], maxText = 4000): TimelineEntry[] {
	const out: TimelineEntry[] = [];
	for (const e of path) {
		const m = messageOf(e);
		const base = { id: e.id, parentId: e.parentId, at: e.timestamp };
		if (m) {
			const role = m.role;
			if (role === "user") {
				out.push({ ...base, role: "user", text: clip(contentText(m.content), maxText), imageCount: imageCount(m.content) });
			} else if (role === "assistant") {
				const parts = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
				const text = parts
					.map((p) => {
						if (p.type === "text") return String(p.text ?? "");
						if (p.type === "toolCall") return `[tool call ${String(p.name ?? "?")}] ${clip(stringifyArgs(p.arguments), 1500)}`;
						return "";
					})
					.filter(Boolean)
					.join("\n");
				out.push({ ...base, role: "assistant", text: clip(text, maxText), imageCount: 0 });
			} else if (role === "toolResult") {
				out.push({ ...base, role: "tool", toolName: typeof m.toolName === "string" ? m.toolName : undefined, text: clip(contentText(m.content), maxText), imageCount: imageCount(m.content) });
			} else if (role === "custom" || role === "branchSummary" || role === "compactionSummary") {
				out.push({ ...base, role: "system", text: clip(contentText(m.content) || String(m.summary ?? ""), maxText), imageCount: 0 });
			} else {
				out.push({ ...base, role: "other", text: clip(contentText(m.content), maxText), imageCount: 0 });
			}
		} else if (e.type === "compaction" || e.type === "branch_summary") {
			out.push({ ...base, role: "system", text: clip(`[${e.type}] ${String(e.summary ?? "")}`, maxText), imageCount: 0 });
		} else if (e.type === "custom_message") {
			out.push({ ...base, role: "system", text: clip(`[${String(e.customType ?? "custom")}] ${contentText(e.content)}`, maxText), imageCount: 0 });
		}
	}
	return out;
}

function stringifyArgs(args: unknown): string {
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		// ipython is the harness's only model tool; its code is the interesting part.
		if (typeof a.code === "string") return a.code;
		if (typeof a.command === "string") return a.command;
	}
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

export function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = Math.floor(max * 0.7);
	return `${s.slice(0, head)}\n…[${s.length - max} chars omitted]…\n${s.slice(s.length - (max - head))}`;
}

/** Render rows for an LLM, keeping the start and (mostly) the end when over budget. */
export function renderTranscript(rows: TimelineEntry[], maxChars = 120_000): string {
	const blocks = rows.map((r) => `### ${r.role}${r.toolName ? ` (${r.toolName})` : ""} · entry ${r.id} · ${r.at}${r.imageCount ? ` · ${r.imageCount} image(s)` : ""}\n${r.text}`);
	const full = blocks.join("\n\n");
	if (full.length <= maxChars) return full;
	const headBudget = Math.floor(maxChars * 0.25);
	const tailBudget = maxChars - headBudget;
	const head: string[] = [];
	let used = 0;
	for (const b of blocks) {
		if (used + b.length > headBudget) break;
		head.push(b);
		used += b.length + 2;
	}
	const tail: string[] = [];
	used = 0;
	for (let i = blocks.length - 1; i >= head.length; i--) {
		const b = blocks[i]!;
		if (used + b.length > tailBudget) break;
		tail.unshift(b);
		used += b.length + 2;
	}
	const omitted = blocks.length - head.length - tail.length;
	return [...head, `…[${omitted} entries omitted]…`, ...tail].join("\n\n");
}

/** Split rows into windows of at most `maxChars` rendered characters, overlapping by `overlap` rows. */
export function windows(rows: TimelineEntry[], maxChars: number, overlap = 4): TimelineEntry[][] {
	const out: TimelineEntry[][] = [];
	let start = 0;
	while (start < rows.length) {
		let size = 0;
		let end = start;
		while (end < rows.length) {
			const len = rows[end]!.text.length + 120;
			if (end > start && size + len > maxChars) break;
			size += len;
			end++;
		}
		out.push(rows.slice(start, end));
		if (end >= rows.length) break;
		start = Math.max(start + 1, end - overlap);
	}
	return out;
}

// ---- harness state (Continual Harness memory) ------------------------------------------------

export interface HarnessRefinementLike {
	timestamp?: string;
	appliedEdits?: Array<{ kind?: string; id?: string; before?: unknown }>;
}

export interface HarnessFilterResult {
	state: Record<string, unknown>;
	included: Array<{ kind: string; id: string; title: string }>;
	excluded: Array<{ kind: string; id: string; title: string; reason: string }>;
}

/**
 * Rewind a raw harness_state.json object to how it looked at `cutoff`. Entries created afterwards
 * are dropped; entries edited afterwards fall back to the `before` recorded by the first later
 * refinement, or are dropped when no earlier version is known. This is what keeps a benchmark
 * run from reading the memory the original session wrote after the checkpoint.
 */
export function filterHarnessState(raw: unknown, cutoffIso: string, refinements: HarnessRefinementLike[] = []): HarnessFilterResult {
	const cutoff = Date.parse(cutoffIso);
	const included: HarnessFilterResult["included"] = [];
	const excluded: HarnessFilterResult["excluded"] = [];
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const entries = (src.entries && typeof src.entries === "object" ? src.entries : {}) as Record<string, Record<string, Record<string, unknown>>>;
	const outEntries: Record<string, Record<string, unknown>> = {};
	const later = refinements
		.filter((r) => r.timestamp && Date.parse(r.timestamp) > cutoff)
		.sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));

	for (const [kind, bucket] of Object.entries(entries)) {
		outEntries[kind] = {};
		if (!bucket || typeof bucket !== "object") continue;
		for (const [id, entry] of Object.entries(bucket)) {
			const title = typeof entry?.title === "string" ? entry.title : id;
			const created = Date.parse(String(entry?.created_at ?? ""));
			const updated = Date.parse(String(entry?.updated_at ?? entry?.created_at ?? ""));
			if (Number.isFinite(created) && created > cutoff) {
				excluded.push({ kind, id, title, reason: "created after the checkpoint" });
				continue;
			}
			if (Number.isFinite(updated) && updated > cutoff) {
				const prior = later.flatMap((r) => r.appliedEdits ?? []).find((e) => e.kind === kind && e.id === id && e.before);
				if (prior?.before && typeof prior.before === "object") {
					outEntries[kind][id] = prior.before as Record<string, unknown>;
					included.push({ kind, id, title });
				} else {
					excluded.push({ kind, id, title, reason: "changed after the checkpoint; no earlier version recorded" });
				}
				continue;
			}
			if (!Number.isFinite(created) && !Number.isFinite(updated)) {
				excluded.push({ kind, id, title, reason: "no timestamps; cannot prove it predates the checkpoint" });
				continue;
			}
			outEntries[kind][id] = entry;
			included.push({ kind, id, title });
		}
	}
	const refinementsKept = Array.isArray(src.refinements)
		? src.refinements.filter((r) => {
				const at = Date.parse(String((r as Record<string, unknown>)?.created_at ?? ""));
				return !Number.isFinite(at) || at <= cutoff;
			})
		: [];
	return { state: { ...src, entries: outEntries, refinements: refinementsKept }, included, excluded };
}
