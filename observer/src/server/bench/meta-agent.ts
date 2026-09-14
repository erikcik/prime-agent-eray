import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetaSettings } from "../../shared/bench.ts";
import { logger } from "../log.ts";
import { benchSocketPath, helperEnv, runProcess, shutdownDaemonAt } from "./proc.ts";

const log = logger("meta-agent");

export interface MetaCall {
	/** Short tag used for the output file name and logs. */
	label: string;
	system: string;
	prompt: string;
	schema: Record<string, unknown>;
	model?: string;
	cwd?: string;
	/** "read" lets the helper inspect files in `cwd` (the judge needs it); default none. */
	tools?: "none" | "read";
	timeoutMs?: number;
}

export interface MetaResult<T> {
	data: T;
	costUsd?: number;
	model: string;
	backend: MetaSettings["backend"];
	outputPath: string;
}

export interface MetaAgentOptions {
	settings: () => MetaSettings;
	/** Where helper outputs and the isolated Claude Code config live. */
	workDir: string;
	agentDir: string;
	primeAgentBin: string;
	claudeBin?: string;
	env?: NodeJS.ProcessEnv;
}

export class MetaAgentError extends Error {}

/** Claude Code aliases mapped to prime-agent catalog ids for the prime-agent backend. */
const PRIME_ALIASES: Record<string, string> = {
	opus: "anthropic/claude-opus-5",
	sonnet: "anthropic/claude-sonnet-4-6",
};

/**
 * Runs the benchmark system's own helpers (capture drafter, trajectory miner, judge, advisor) as
 * one-shot structured calls. They are deliberately outside the harness under test: the default
 * backend is Claude Code with `--json-schema`, isolated from the user's ~/.claude when an OAuth
 * token is available so personal CLAUDE.md, skills and plugins cannot steer a judge.
 */
export class MetaAgent {
	constructor(private readonly o: MetaAgentOptions) {
		mkdirSync(join(o.workDir, "meta"), { recursive: true });
	}

	async call<T>(c: MetaCall): Promise<MetaResult<T>> {
		const s = this.o.settings();
		return s.backend === "prime-agent" ? this.viaPrimeAgent<T>(c, s) : this.viaClaudeCode<T>(c, s);
	}

	/** Env for any Claude Code process we launch: subscription token + private config dir when possible. */
	claudeEnv(configDir: string): { env: NodeJS.ProcessEnv; isolated: boolean } {
		const base = this.o.env ?? process.env;
		const token = base.CLAUDE_CODE_OAUTH_TOKEN || base.ANTHROPIC_OAUTH_TOKEN;
		if (!token) return { env: helperEnv(base), isolated: false };
		mkdirSync(configDir, { recursive: true });
		return { env: helperEnv(base, { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir }), isolated: true };
	}

	get claudeBin(): string {
		return this.o.claudeBin ?? process.env.PRIME_BENCH_CLAUDE_BIN ?? "claude";
	}

	private async viaClaudeCode<T>(c: MetaCall, s: MetaSettings): Promise<MetaResult<T>> {
		const id = randomUUID().slice(0, 8);
		const model = c.model ?? s.model;
		const outputPath = join(this.o.workDir, "meta", `${c.label}-${id}.json`);
		const { env } = this.claudeEnv(join(this.o.workDir, "cc-config-meta"));
		const tools = c.tools === "read" ? "Read,Grep,Glob" : "";
		const args = [
			"-p",
			"--output-format",
			"json",
			"--no-session-persistence",
			"--model",
			model,
			"--json-schema",
			JSON.stringify(c.schema),
			"--append-system-prompt",
			c.system,
			"--tools",
			tools,
		];
		if (tools) args.push("--allowedTools", tools);
		const proc = runProcess({ bin: this.claudeBin, args, cwd: c.cwd ?? this.o.workDir, env, stdoutPath: outputPath, stdin: c.prompt, timeoutMs: c.timeoutMs ?? 20 * 60_000 });
		const res = await proc.done;
		const text = safeRead(outputPath);
		if (res.timedOut) throw new MetaAgentError(`${c.label}: helper timed out`);
		try {
			const parsed = parseClaudeResult<T>(text);
			return { data: parsed.data, costUsd: parsed.costUsd, model, backend: "claude-code", outputPath };
		} catch (e) {
			const detail = res.stderrTail.trim().split("\n").slice(-3).join(" | ");
			log.warn(`${c.label} failed (exit ${res.code}): ${e instanceof Error ? e.message : String(e)} ${detail}`);
			throw new MetaAgentError(`${c.label}: ${e instanceof Error ? e.message : String(e)}${detail ? ` (${detail})` : ""}`);
		}
	}

	private async viaPrimeAgent<T>(c: MetaCall, s: MetaSettings): Promise<MetaResult<T>> {
		const id = randomUUID().slice(0, 8);
		const alias = c.model ?? s.model;
		const model = PRIME_ALIASES[alias] ?? alias;
		const outputPath = join(this.o.workDir, "meta", `${c.label}-${id}.jsonl`);
		const socket = benchSocketPath(`meta-${id}`);
		const system = `${c.system}\n\nRespond with ONLY a JSON object (no prose, no code fence) that validates against this JSON Schema:\n${JSON.stringify(c.schema)}`;
		const args = ["-p", "--mode", "json", "--no-session", "--daemon-socket", socket, "--model", model, "--append-system-prompt", system];
		if (c.tools !== "read") args.push("--no-tools");
		args.push(c.prompt);
		const env = helperEnv(this.o.env ?? process.env, { PRIME_AGENT_CODING_AGENT_DIR: this.o.agentDir });
		const proc = runProcess({ bin: this.o.primeAgentBin, args, cwd: c.cwd ?? this.o.workDir, env, stdoutPath: outputPath, timeoutMs: c.timeoutMs ?? 20 * 60_000 });
		const res = await proc.done;
		await shutdownDaemonAt(socket);
		if (res.timedOut) throw new MetaAgentError(`${c.label}: helper timed out`);
		const { text, costUsd } = lastAssistantText(safeRead(outputPath));
		const data = extractJson<T>(text);
		if (data === undefined) throw new MetaAgentError(`${c.label}: no JSON in reply (exit ${res.code}) ${res.stderrTail.slice(-300)}`);
		return { data, costUsd, model, backend: "prime-agent", outputPath };
	}
}

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

export function parseClaudeResult<T>(text: string): { data: T; costUsd?: number } {
	let doc: Record<string, unknown>;
	try {
		doc = JSON.parse(text.trim()) as Record<string, unknown>;
	} catch {
		throw new MetaAgentError(`unparseable Claude Code output: ${text.slice(0, 200)}`);
	}
	const costUsd = typeof doc.total_cost_usd === "number" ? doc.total_cost_usd : undefined;
	if (doc.is_error === true) throw new MetaAgentError(`Claude Code error: ${String(doc.result ?? doc.subtype ?? "unknown")}`);
	if (doc.structured_output && typeof doc.structured_output === "object") return { data: doc.structured_output as T, costUsd };
	const fallback = typeof doc.result === "string" ? extractJson<T>(doc.result) : undefined;
	if (fallback === undefined) throw new MetaAgentError("Claude Code returned no structured output");
	return { data: fallback, costUsd };
}

/** Last assistant text + summed cost from a `prime-agent --mode json` event stream. */
export function lastAssistantText(stream: string): { text: string; costUsd: number } {
	let text = "";
	let costUsd = 0;
	for (const line of stream.split("\n")) {
		if (!line.startsWith("{")) continue;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (ev.type !== "message_end") continue;
		const m = ev.message as Record<string, unknown> | undefined;
		if (m?.role !== "assistant") continue;
		const parts = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
		const t = parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("");
		if (t.trim()) text = t;
		const cost = (m.usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
		if (typeof cost === "number") costUsd += cost;
	}
	return { text, costUsd };
}

/** First parseable top-level JSON object in free text (tolerates code fences and prose). */
export function extractJson<T>(text: string): T | undefined {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		// fall through to scanning
	}
	for (let start = trimmed.indexOf("{"); start >= 0; start = trimmed.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(trimmed.slice(start, i + 1)) as T;
					} catch {
						break;
					}
				}
			}
		}
	}
	return undefined;
}
