import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdvisorEvent, VerifiedSkill } from "../../shared/bench.ts";
import { parseSessionFile } from "../disk/sessions-reader.ts";
import { logger } from "../log.ts";
import type { MetaAgent } from "./meta-agent.ts";
import { skillBlock } from "./runner.ts";
import { currentBranch, renderTranscript, toTimeline } from "./snapshot.ts";
import { type BenchStore, newId, readJsonFile, writeJsonAtomic } from "./store.ts";

const log = logger("advisor");

export interface LiveSession {
	sessionId: string;
	sessionFile: string;
	activeSessionId: string;
	isStreaming: boolean;
}

export interface AdvisorDeps {
	store: BenchStore;
	meta: MetaAgent;
	liveSessions: () => LiveSession[];
	verified: () => VerifiedSkill[];
	inject: (activeSessionId: string, message: string, streaming: boolean) => Promise<void>;
	onEvent?: (e: AdvisorEvent) => void;
}

interface SessionState {
	lastCheckAt: string;
	/** variantId -> ISO time it was last sent into this session. */
	sent: Record<string, string>;
}

const RESEND_AFTER_MS = 6 * 60 * 60_000;

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		major: { type: "boolean" },
		stepSummary: { type: "string" },
		chosenVariantIds: { type: "array", items: { type: "string" } },
	},
	required: ["major", "stepSummary", "chosenVariantIds"],
};

const SYSTEM = `You watch a long-horizon AI agent while it works and decide whether it is starting a MAJOR step: a decision or piece of work whose quality depends on expertise and taste (setting up company email, producing app screenshots, choosing influencers, designing an ad, planning a launch, picking research sources). Routine work (reading files, small edits, re-running commands) is not major.

You also get a catalog of skills that were verified on benchmark checkpoints: each beat the raw harness on similar past steps. If the agent is starting a major step AND one or more catalog skills clearly fit it, choose them (at most 2). Choose nothing when the fit is weak; a wrong skill derails the agent.

Return major, a one-sentence stepSummary of what the agent is about to do, and chosenVariantIds (ids from the catalog only).`;

/**
 * Every N minutes, look at what each live session did since the last look; when it is starting a
 * major step that a benchmark-verified skill fits, plug that skill into the session. The skill text
 * is inserted verbatim: the helper only chooses, it never writes what the agent reads.
 */
export class Advisor {
	private timer: NodeJS.Timeout | undefined;
	private busy = false;
	private state: Record<string, SessionState>;
	private readonly statePath: string;
	private readonly eventsPath: string;

	constructor(private readonly d: AdvisorDeps) {
		this.statePath = join(d.store.advisorDir, "state.json");
		this.eventsPath = join(d.store.advisorDir, "events.jsonl");
		this.state = readJsonFile<Record<string, SessionState>>(this.statePath) ?? {};
	}

	start(): void {
		this.timer = setInterval(() => void this.tick(), 60_000);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	private async tick(): Promise<void> {
		const settings = this.d.store.settings().advisor;
		if (settings.mode === "off" || this.busy) return;
		this.busy = true;
		try {
			const due = Date.now() - settings.intervalMinutes * 60_000;
			for (const s of this.d.liveSessions()) {
				const st = this.state[s.sessionId];
				if (st && Date.parse(st.lastCheckAt) > due) continue;
				await this.evaluate(s).catch((e) => log.warn(`advisor check of ${s.sessionId} failed`, e));
			}
		} finally {
			this.busy = false;
		}
	}

	/** One check of one session. Also callable from the UI ("check now"). */
	async evaluate(s: LiveSession): Promise<AdvisorEvent | undefined> {
		const settings = this.d.store.settings().advisor;
		const st: SessionState = this.state[s.sessionId] ?? { lastCheckAt: new Date(0).toISOString(), sent: {} };
		const since = st.lastCheckAt;
		st.lastCheckAt = new Date().toISOString();
		this.state[s.sessionId] = st;
		writeJsonAtomic(this.statePath, this.state);

		const catalog = this.d.verified();
		if (catalog.length === 0) return undefined;
		const parsed = await parseSessionFile(s.sessionFile);
		const branch = currentBranch(parsed.entries);
		const fresh = branch.filter((e) => e.timestamp > since);
		if (fresh.length === 0) return undefined;
		// A little history before the new part so the helper knows what the task is.
		const firstFresh = branch.indexOf(fresh[0]!);
		const context = branch.slice(Math.max(0, firstFresh - 12));
		const catalogText = catalog
			.map((v) => `- id: ${v.variant.id}\n  from experiment: ${v.experimentTitle} (pass rate ${(v.passRate * 100).toFixed(0)}% vs raw ${(v.baselinePassRate * 100).toFixed(0)}%)\n  verified on: ${v.taskTitles.join("; ")}\n  skill summary: ${skillSummary(v.variant.skill)}`)
			.join("\n");
		const prompt = `## Skill catalog\n${catalogText}\n\n## Recent trajectory (the part after the last check starts at entry ${fresh[0]!.id})\n${renderTranscript(toTimeline(context, 2000), 60_000)}`;
		const res = await this.d.meta.call<{ major: boolean; stepSummary: string; chosenVariantIds: string[] }>({ label: `advisor-${s.sessionId.slice(0, 8)}`, system: SYSTEM, prompt, schema: SCHEMA, model: settings.model, timeoutMs: 5 * 60_000 });
		const now = Date.now();
		const chosen = (res.data.chosenVariantIds ?? [])
			.map((id) => catalog.find((v) => v.variant.id === id))
			.filter((v): v is VerifiedSkill => !!v)
			.filter((v) => !st.sent[v.variant.id] || now - Date.parse(st.sent[v.variant.id]!) > RESEND_AFTER_MS)
			.slice(0, 2);
		const event: AdvisorEvent = {
			id: newId("adv"),
			at: new Date().toISOString(),
			sessionId: s.sessionId,
			activeSessionId: s.activeSessionId,
			major: !!res.data.major,
			stepSummary: String(res.data.stepSummary ?? ""),
			chosenVariantIds: chosen.map((v) => v.variant.id),
			action: "skipped",
		};
		if (event.major && chosen.length > 0) {
			event.message = advisorMessage(event.stepSummary, chosen);
			if (settings.mode === "auto") {
				try {
					await this.d.inject(s.activeSessionId, event.message, s.isStreaming);
					event.action = "sent";
					for (const v of chosen) st.sent[v.variant.id] = event.at;
					writeJsonAtomic(this.statePath, this.state);
				} catch (e) {
					event.action = "error";
					event.error = e instanceof Error ? e.message : String(e);
				}
			} else {
				event.action = "suggested";
			}
		}
		this.record(event);
		return event;
	}

	async sendSuggestion(eventId: string, live: LiveSession | undefined): Promise<AdvisorEvent> {
		const event = this.events().find((e) => e.id === eventId);
		if (!event?.message) throw Object.assign(new Error("no such suggestion"), { status: 404 });
		if (!live) throw Object.assign(new Error("that session is no longer live"), { status: 409 });
		await this.d.inject(live.activeSessionId, event.message, live.isStreaming);
		const st = this.state[event.sessionId] ?? { lastCheckAt: new Date().toISOString(), sent: {} };
		for (const id of event.chosenVariantIds) st.sent[id] = new Date().toISOString();
		this.state[event.sessionId] = st;
		writeJsonAtomic(this.statePath, this.state);
		const sent: AdvisorEvent = { ...event, id: newId("adv"), at: new Date().toISOString(), action: "sent" };
		this.record(sent);
		return sent;
	}

	events(limit = 200): AdvisorEvent[] {
		if (!existsSync(this.eventsPath)) return [];
		const lines = readFileSync(this.eventsPath, "utf8").trim().split("\n").filter(Boolean);
		const out: AdvisorEvent[] = [];
		for (const l of lines.slice(-limit)) {
			try {
				out.push(JSON.parse(l) as AdvisorEvent);
			} catch {
				// skip a torn line
			}
		}
		return out.reverse();
	}

	private record(event: AdvisorEvent): void {
		appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
		this.d.onEvent?.(event);
	}
}

export function advisorMessage(stepSummary: string, chosen: VerifiedSkill[]): string {
	const blocks = chosen.map((v) => skillBlock(v.variant)).join("\n\n");
	const plural = chosen.length > 1;
	return `You are about to attempt a major step: ${stepSummary}\n\nHere ${plural ? "are skills" : "is a skill"} that ${plural ? "were" : "was"} verified on benchmark checkpoints built from earlier attempts at steps like this one. Apply ${plural ? "them" : "it"} to this step before you continue.\n\n${blocks}`;
}

function skillSummary(skill: string): string {
	const desc = /^description:\s*(.+)$/m.exec(skill)?.[1];
	return (desc ?? skill.replace(/^---[\s\S]*?---/, "").trim()).replace(/\s+/g, " ").slice(0, 300);
}
