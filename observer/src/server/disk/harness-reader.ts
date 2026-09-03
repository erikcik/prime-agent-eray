import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type HarnessEntry,
	type HarnessEntryKind,
	type HarnessScope,
	type HarnessState,
	type HarnessView,
	type RefinementResult,
	emptyHarnessState,
} from "../../shared/harness.ts";
import { readJsonl } from "./jsonl.ts";

/**
 * Reimplementation of the read side of packages/coding-agent/src/core/refinement/refinement.ts
 * (loadHarnessState / mergeHarnessStates / refinement history). Pure and non-throwing: corrupt or
 * missing state degrades to empty, exactly like the harness does.
 */

const KINDS: HarnessEntryKind[] = ["prompt", "memory", "skill", "subagent"];

export function harnessStatePath(dir: string): string {
	return join(dir, "harness_state.json");
}

export function refinementHistoryPath(dir: string): string {
	return join(dir, "refinements.jsonl");
}

export async function loadHarnessState(dir: string, scope: HarnessScope): Promise<HarnessState> {
	let raw: string;
	try {
		raw = await readFile(harnessStatePath(dir), "utf8");
	} catch {
		return emptyHarnessState();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyHarnessState();
	}
	return normalizeHarnessState(parsed, scope);
}

export function normalizeHarnessState(parsed: unknown, scope: HarnessScope): HarnessState {
	const state = emptyHarnessState();
	if (!parsed || typeof parsed !== "object") return state;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.schema === "number") state.schema = obj.schema;
	const entries = (obj.entries ?? {}) as Record<string, unknown>;
	for (const kind of KINDS) {
		const bucket = entries[kind];
		if (!bucket || typeof bucket !== "object") continue;
		for (const [id, value] of Object.entries(bucket as Record<string, unknown>)) {
			const entry = normalizeEntry(id, kind, value, scope);
			if (entry) state.entries[kind][id] = entry;
		}
	}
	if (Array.isArray(obj.refinements)) {
		state.refinements = obj.refinements.filter((r): r is HarnessState["refinements"][number] => !!r && typeof r === "object");
	}
	return state;
}

function normalizeEntry(id: string, kind: HarnessEntryKind, value: unknown, scope: HarnessScope): HarnessEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const str = (x: unknown, d = ""): string => (typeof x === "string" ? x : d);
	const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
	return {
		id: str(v.id, id),
		kind,
		title: str(v.title, id),
		content: str(v.content),
		path: str(v.path),
		scope: v.scope === "local" || v.scope === "global" ? v.scope : scope,
		reference: rec(v.reference),
		arguments: rec(v.arguments),
		metadata: rec(v.metadata),
		source: str(v.source, "unknown"),
		created_at: str(v.created_at),
		updated_at: str(v.updated_at),
		version: typeof v.version === "number" ? v.version : 1,
	};
}

/** Local entries win; colliding ids are prefixed by scope, as in mergeHarnessStates. */
export function mergeHarnessStates(global: HarnessState, local: HarnessState | undefined): HarnessState {
	if (!local) return structuredClone(global);
	const merged = emptyHarnessState();
	merged.schema = Math.max(global.schema, local.schema);
	for (const kind of KINDS) {
		const g = global.entries[kind];
		const l = local.entries[kind];
		const collisions = new Set(Object.keys(g).filter((id) => id in l));
		for (const [id, entry] of Object.entries(g)) {
			const key = collisions.has(id) ? `global:${id}` : id;
			merged.entries[kind][key] = { ...entry, scope: entry.scope ?? "global" };
		}
		for (const [id, entry] of Object.entries(l)) {
			const key = collisions.has(id) ? `local:${id}` : id;
			merged.entries[kind][key] = { ...entry, scope: entry.scope ?? "local" };
		}
	}
	merged.refinements = [...global.refinements, ...local.refinements];
	return merged;
}

export async function loadGlobalRefinementHistory(globalDir: string): Promise<RefinementResult[]> {
	try {
		const { entries } = await readJsonl<RefinementResult>(refinementHistoryPath(globalDir));
		return entries
			.filter((r) => r && typeof r === "object" && typeof r.id === "string")
			.map((r) => ({ ...r, scope: r.scope ?? "global", sourceFile: refinementHistoryPath(globalDir) }));
	} catch {
		return [];
	}
}

/** Session-local refinements are `custom` JSONL entries with customType "prime-agent.refinement". */
export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";

export function refinementFromSessionEntry(entry: Record<string, unknown>, sessionFile: string, sessionId: string): RefinementResult | undefined {
	if (entry.type !== "custom" || entry.customType !== REFINEMENT_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!data || typeof data !== "object" || typeof (data as { id?: unknown }).id !== "string") return undefined;
	const r = data as RefinementResult;
	return {
		...r,
		scope: r.scope ?? inferScope(r),
		sourceFile: sessionFile,
		sessionId,
		timestamp: typeof entry.timestamp === "string" ? entry.timestamp : r.timestamp,
	};
}

function inferScope(r: RefinementResult): HarnessScope {
	const p = r.harnessStatePath ?? "";
	return p.includes(`${"/"}session-artifacts${"/"}`) ? "local" : "global";
}

/** Session-recorded results win over the global file when ids collide (refinement.ts mergeHistory). */
export function mergeRefinementHistory(global: RefinementResult[], session: RefinementResult[]): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const r of global) byId.set(r.id, r);
	for (const r of session) byId.set(r.id, r);
	return [...byId.values()].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
}

export async function buildHarnessView(options: {
	globalDir: string;
	localDir?: string;
	sessionId?: string;
	sessionRefinements?: RefinementResult[];
}): Promise<HarnessView> {
	const global = await loadHarnessState(options.globalDir, "global");
	const local = options.localDir ? await loadHarnessState(options.localDir, "local") : undefined;
	const history = mergeRefinementHistory(await loadGlobalRefinementHistory(options.globalDir), options.sessionRefinements ?? []);
	return {
		global,
		local,
		merged: mergeHarnessStates(global, local),
		history,
		globalDir: options.globalDir,
		localDir: options.localDir,
		sessionId: options.sessionId,
	};
}
