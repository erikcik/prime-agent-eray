import { parseSessionFile } from "../disk/sessions-reader.ts";
import type { SessionUserMessage } from "./activity.ts";
import type { MetaAgent } from "./meta-agent.ts";
import { isUserMessage, pathToEntry, renderTranscript, toTimeline } from "./snapshot.ts";

/** Cheap prefilter; the helper decides whether the message really asks for a benchmark. */
export const INTERVENTION_PATTERN = /\bbench\s?mark/i;

/** Marker the advisor wraps every injected skill in (runner.skillBlock). */
export const ADVISOR_MARKER = "<benchmark-skill";

/**
 * The advisor's own injections arrive as user messages and mention benchmarks; without this
 * guard they were captured as operator requests, creating tasks from the system's own output.
 */
export function looksLikeIntervention(text: string): boolean {
	if (text.includes(ADVISOR_MARKER)) return false;
	return INTERVENTION_PATTERN.test(text);
}

interface Classification {
	isBenchmarkRequest: boolean;
	desiredTrajectory: string;
	anchorEntryId: string;
	title: string;
}

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		isBenchmarkRequest: { type: "boolean" },
		desiredTrajectory: { type: "string" },
		anchorEntryId: { type: "string" },
		title: { type: "string" },
	},
	required: ["isBenchmarkRequest", "desiredTrajectory", "anchorEntryId", "title"],
};

const SYSTEM = `An operator is supervising a long-horizon AI agent. They just sent the agent a message. Decide whether that message asks for the current behaviour to be captured as a benchmark (e.g. "you should have researched YouTube, Whop and Skool first. benchmark this", "this was wrong, make a benchmark out of it").

If it does:
- desiredTrajectory: restate, precisely and completely, what the operator says the agent should have done instead (the target trajectory). Keep every concrete requirement. Do not add your own.
- anchorEntryId: the entry id (from the transcript below, before the operator's message) where the agent's trajectory started going the wrong way. Prefer the user message that set up the step; otherwise the last entry just before the wrong decision.
- title: short name for the checkpoint.
If it does not, set isBenchmarkRequest=false and leave the other fields empty strings.`;

export interface InterventionResult {
	classification: Classification;
	anchorEntryId: string;
}

/**
 * Turn an operator message into capture parameters. Returns undefined when the helper says the
 * message is not a benchmark request. The anchor is validated to lie on the path strictly before
 * the operator's message; otherwise it falls back to the last user message before it.
 */
export async function classifyIntervention(meta: MetaAgent, msg: SessionUserMessage): Promise<InterventionResult | undefined> {
	const parsed = await parseSessionFile(msg.sessionFile);
	const path = pathToEntry(parsed.entries, msg.entry.id);
	const before = path.slice(0, -1);
	const rows = toTimeline(before.slice(-80), 2000);
	const prompt = `## Transcript before the operator's message (most recent part)\n${renderTranscript(rows, 70_000)}\n\n## Operator's message (entry ${msg.entry.id})\n${msg.text}`;
	const res = await meta.call<Classification>({ label: "intervention", system: SYSTEM, prompt, schema: SCHEMA, timeoutMs: 5 * 60_000 });
	const c = res.data;
	if (!c.isBenchmarkRequest) return undefined;
	const onPath = new Set(before.map((e) => e.id));
	const fallback = [...before].reverse().find(isUserMessage)?.id;
	const anchorEntryId = c.anchorEntryId && onPath.has(c.anchorEntryId) ? c.anchorEntryId : fallback;
	if (!anchorEntryId) return undefined;
	return { classification: c, anchorEntryId };
}

export function interventionNotes(msg: SessionUserMessage): string {
	return `Captured from an operator intervention (entry ${msg.entry.id}): "${msg.text.slice(0, 2000)}"`;
}
