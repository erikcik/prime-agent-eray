import type { TimelineEntry } from "../../shared/bench.ts";
import { clip } from "./snapshot.ts";

export interface CcStreamSummary {
	rows: TimelineEntry[];
	costUsd?: number;
	isError: boolean;
	resultText?: string;
	sessionId?: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Parse `claude -p --output-format stream-json --verbose` output into timeline rows so the judge
 * reads a Claude Code trial the same way it reads a prime-agent trial.
 */
export function parseClaudeStream(text: string, maxText = 3000): CcStreamSummary {
	const rows: TimelineEntry[] = [];
	const out: CcStreamSummary = { rows, isError: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let n = 0;
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const at = new Date().toISOString();
		if (ev.type === "system" && typeof ev.session_id === "string") out.sessionId = ev.session_id;
		if (ev.type === "assistant" || ev.type === "user") {
			const msg = (ev.message ?? {}) as { content?: unknown };
			const parts = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
			for (const p of parts) {
				const id = `cc${++n}`;
				if (p.type === "text" && String(p.text ?? "").trim()) {
					rows.push({ id, parentId: null, at, role: ev.type === "assistant" ? "assistant" : "user", text: clip(String(p.text), maxText), imageCount: 0 });
				} else if (p.type === "tool_use") {
					rows.push({ id, parentId: null, at, role: "assistant", text: clip(`[tool call ${String(p.name ?? "?")}] ${JSON.stringify(p.input ?? {})}`, maxText), imageCount: 0 });
				} else if (p.type === "tool_result") {
					const content = p.content;
					const textOut = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => ((c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n") : "";
					const images = Array.isArray(content) ? content.filter((c) => (c as { type?: string }).type === "image").length : 0;
					rows.push({ id, parentId: null, at, role: "tool", text: clip(textOut, maxText), imageCount: images });
				}
			}
		}
		if (ev.type === "result") {
			out.isError = ev.is_error === true;
			if (typeof ev.total_cost_usd === "number") out.costUsd = ev.total_cost_usd;
			if (typeof ev.result === "string") out.resultText = ev.result;
			const u = (ev.usage ?? {}) as Record<string, unknown>;
			out.tokens = {
				input: num(u.input_tokens),
				output: num(u.output_tokens),
				cacheRead: num(u.cache_read_input_tokens),
				cacheWrite: num(u.cache_creation_input_tokens),
			};
		}
	}
	return out;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
