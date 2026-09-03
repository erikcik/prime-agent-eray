// Structural copies of Prime Agent's Continual Harness state types
// (packages/coding-agent/src/core/refinement/refinement.ts). Kept independent so the observer
// never deep-imports harness internals.

export type HarnessEntryKind = "prompt" | "memory" | "skill" | "subagent";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: HarnessEntryKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementRecord {
	id: string;
	trigger?: string;
	changes?: unknown[];
	evidence?: string;
	outcome?: string;
	created_at?: string;
	[key: string]: unknown;
}

export interface HarnessState {
	schema: number;
	entries: Record<HarnessEntryKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementRecord[];
}

export interface AppliedRefinementEdit {
	kind: HarnessEntryKind;
	id?: string;
	action?: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied?: boolean;
	error?: string;
	[key: string]: unknown;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale?: string;
	expectedOutcome?: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath?: string;
	rollbackId?: string;
	scope?: HarnessScope;
	/** Observer-added: where this record came from. */
	sourceFile?: string;
	sessionId?: string;
	timestamp?: string;
}

export interface HarnessView {
	global: HarnessState;
	local?: HarnessState;
	merged: HarnessState;
	history: RefinementResult[];
	globalDir: string;
	localDir?: string;
	sessionId?: string;
}

export interface SkillSummary {
	name: string;
	description: string;
	kind: "markdown" | "python" | string;
	source: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	importName?: string;
	license?: string;
	metadata?: Record<string, unknown>;
}

export interface SkillDoc {
	name: string;
	markdown: string;
	pyproject?: string;
	filePath: string;
}

export function emptyHarnessState(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}
