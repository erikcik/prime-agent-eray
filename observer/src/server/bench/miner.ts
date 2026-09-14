import type { BenchCandidate, CandidateKind, TimelineEntry } from "../../shared/bench.ts";
import { parseSessionFile, type SessionEntry } from "../disk/sessions-reader.ts";
import type { MetaAgent } from "./meta-agent.ts";
import { currentBranch, renderTranscript, toTimeline, windows } from "./snapshot.ts";
import { type BenchStore, newId } from "./store.ts";

const KINDS: CandidateKind[] = ["decision", "setup", "research", "creative", "delivery", "recovery", "other"];

interface MinedCandidate {
	anchorEntryId: string;
	kind: string;
	title: string;
	summary: string;
	decision: string;
	whyMajor: string;
	alternatives: string[];
	evidenceEntryIds: string[];
}

const MINER_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		candidates: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					anchorEntryId: { type: "string" },
					kind: { type: "string", enum: KINDS },
					title: { type: "string" },
					summary: { type: "string" },
					decision: { type: "string" },
					whyMajor: { type: "string" },
					alternatives: { type: "array", items: { type: "string" } },
					evidenceEntryIds: { type: "array", items: { type: "string" } },
				},
				required: ["anchorEntryId", "kind", "title", "summary", "decision", "whyMajor", "alternatives", "evidenceEntryIds"],
			},
		},
	},
	required: ["candidates"],
};

const MINER_SYSTEM = `You review the trajectory of a long-horizon AI agent (building and marketing apps, websites, social media, running a company) and find the checkpoints worth turning into benchmarks.

A checkpoint is a MAJOR step or decision whose quality depends on expertise and taste, where a different harness, memory or inserted skill could plausibly change the outcome. Examples: deciding how to set up a company Google Workspace mailbox through the browser, producing App Store screenshots, choosing which influencers should promote an app, picking an ad concept and its music, deciding what research to do before a launch, choosing a pricing model, recovering from a failed deploy.

Not checkpoints: reading files, routine edits, fixing a typo, re-running a command, small talk.

For each checkpoint:
- anchorEntryId: an entry id from THIS window where a re-run should start so that it faces the same decision. Prefer the user message that started the step; otherwise the last entry just before the agent committed to the decision. Never pick an entry after the decision was made.
- kind: decision | setup | research | creative | delivery | recovery | other
- title: short and specific.
- summary: what happened around this step, 2-4 sentences.
- decision: what the agent decided or did.
- whyMajor: why this matters for the end result.
- alternatives: what an expert might have done instead (may be empty).
- evidenceEntryIds: entry ids that show the decision and its consequences.

Return at most 6 checkpoints for this window, best first. Return an empty list if the window has none.`;

export interface MineOptions {
	maxWindowChars?: number;
	onProgress?: (done: number, total: number) => void;
}

export async function mineSession(store: BenchStore, meta: MetaAgent, sessionFile: string, opts: MineOptions = {}): Promise<BenchCandidate[]> {
	const parsed = await parseSessionFile(sessionFile);
	const branch = currentBranch(parsed.entries);
	const rows = toTimeline(branch, 1500);
	const byId = new Map(parsed.entries.map((e) => [e.id, e]));
	const existing = new Set(store.listCandidates().filter((c) => c.sessionFile === sessionFile).map((c) => c.anchorEntryId));
	const minerRunId = newId("mine");
	const chunks = windows(rows, opts.maxWindowChars ?? 90_000, 6);
	const saved: BenchCandidate[] = [];
	const seenAnchors = new Set<string>();

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const ids = new Set(chunk.map((r) => r.id));
		const prompt = `Session ${parsed.summary.sessionId} (${parsed.summary.name ?? parsed.summary.firstMessage?.slice(0, 80) ?? "unnamed"}), cwd ${parsed.header?.cwd ?? "?"}.\nWindow ${i + 1} of ${chunks.length}.\n\n${renderTranscript(chunk, (opts.maxWindowChars ?? 90_000) + 20_000)}`;
		const res = await meta.call<{ candidates: MinedCandidate[] }>({ label: `mine-${i + 1}`, system: MINER_SYSTEM, prompt, schema: MINER_SCHEMA });
		for (const c of res.data.candidates ?? []) {
			if (!ids.has(c.anchorEntryId) || existing.has(c.anchorEntryId) || seenAnchors.has(c.anchorEntryId)) continue;
			const anchor = byId.get(c.anchorEntryId);
			if (!anchor) continue;
			seenAnchors.add(c.anchorEntryId);
			const evidence = (c.evidenceEntryIds ?? []).filter((id) => byId.has(id));
			const candidate: BenchCandidate = {
				id: newId("cand"),
				status: "pending",
				createdAt: new Date().toISOString(),
				sessionId: parsed.summary.sessionId,
				sessionFile,
				anchorEntryId: c.anchorEntryId,
				anchorAt: anchor.timestamp,
				kind: (KINDS as string[]).includes(c.kind) ? (c.kind as CandidateKind) : "other",
				title: String(c.title ?? "").slice(0, 200),
				summary: String(c.summary ?? ""),
				decision: String(c.decision ?? ""),
				whyMajor: String(c.whyMajor ?? ""),
				alternatives: Array.isArray(c.alternatives) ? c.alternatives.map(String) : [],
				evidenceEntryIds: evidence,
				images: imagesNear(rows, [c.anchorEntryId, ...evidence], byId),
				minerRunId,
			};
			store.saveCandidate(candidate);
			saved.push(candidate);
		}
		opts.onProgress?.(i + 1, chunks.length);
	}
	return saved;
}

/** Screenshots in the evidence entries and the tool results right after the anchor. */
function imagesNear(rows: TimelineEntry[], ids: string[], byId: Map<string, SessionEntry>): BenchCandidate["images"] {
	const wanted = new Set(ids);
	const anchorIdx = rows.findIndex((r) => r.id === ids[0]);
	if (anchorIdx >= 0) for (const r of rows.slice(anchorIdx, anchorIdx + 8)) wanted.add(r.id);
	const out: BenchCandidate["images"] = [];
	for (const id of wanted) {
		const content = ((byId.get(id)?.message as { content?: unknown } | undefined)?.content ?? []) as unknown;
		if (!Array.isArray(content)) continue;
		content.forEach((p, index) => {
			const part = p as { type?: string; mimeType?: string };
			if (part?.type === "image") out.push({ entryId: id, index, mimeType: part.mimeType ?? "image/png" });
		});
		if (out.length >= 12) break;
	}
	return out;
}

export async function readEntryImage(sessionFile: string, entryId: string, index: number): Promise<{ data: Buffer; mimeType: string } | undefined> {
	const parsed = await parseSessionFile(sessionFile);
	const e = parsed.entries.find((x) => x.id === entryId);
	const content = (e?.message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const part = content[index] as { type?: string; data?: string; mimeType?: string } | undefined;
	if (part?.type !== "image" || typeof part.data !== "string") return undefined;
	return { data: Buffer.from(part.data, "base64"), mimeType: part.mimeType ?? "image/png" };
}
