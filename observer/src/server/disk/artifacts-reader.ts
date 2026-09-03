import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RlmSubagentRecord, SessionArtifacts } from "../../shared/api.ts";

/**
 * session-artifacts/<sessionId>/
 *   harness/harness_state.json, scheduled-jobs.json, kernel-state.*,
 *   sub-<childId>/rlm-subagent.json + <childSessionId>.jsonl + session-artifacts/... (recursive)
 */
export async function readSessionArtifacts(artifactDir: string): Promise<SessionArtifacts> {
	const out: SessionArtifacts = { dir: artifactDir, subagents: [], scheduledJobs: [], hasLocalHarness: false };
	let names: string[];
	try {
		names = await readdir(artifactDir);
	} catch {
		return { ...out, dir: undefined };
	}
	for (const name of names) {
		const full = join(artifactDir, name);
		if (name === "harness") {
			try {
				await stat(join(full, "harness_state.json"));
				out.hasLocalHarness = true;
			} catch {
				// no state file yet
			}
		} else if (name === "scheduled-jobs.json") {
			out.scheduledJobs = await readJsonArray(full);
		} else if (name.startsWith("sub-")) {
			const rec = await readSubagentRecord(full, name);
			if (rec) out.subagents.push(rec);
		}
	}
	out.subagents.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
	return out;
}

async function readSubagentRecord(subDir: string, dirName: string): Promise<RlmSubagentRecord | undefined> {
	const childId = dirName;
	let meta: Record<string, unknown> = {};
	try {
		meta = JSON.parse(await readFile(join(subDir, "rlm-subagent.json"), "utf8")) as Record<string, unknown>;
	} catch {
		// tolerate a missing/corrupt record; we still know the child dir exists
	}
	let sessionFile: string | undefined = typeof meta.sessionFile === "string" ? meta.sessionFile : undefined;
	if (!sessionFile) {
		try {
			const jsonl = (await readdir(subDir)).find((f) => f.endsWith(".jsonl"));
			if (jsonl) sessionFile = join(subDir, jsonl);
		} catch {
			// ignore
		}
	}
	return {
		...meta,
		childId: typeof meta.childId === "string" ? meta.childId : childId,
		sessionName: typeof meta.sessionName === "string" ? meta.sessionName : undefined,
		sessionDir: typeof meta.sessionDir === "string" ? meta.sessionDir : subDir,
		sessionFile,
		rlmParentNodeId: typeof meta.rlmParentNodeId === "string" ? meta.rlmParentNodeId : undefined,
		prompt: typeof meta.prompt === "string" ? meta.prompt : undefined,
		spawnCode: typeof meta.spawnCode === "string" ? meta.spawnCode : undefined,
		model: normalizeModel(meta.model),
		status: typeof meta.status === "string" ? meta.status : undefined,
		createdAt: normalizeTime(meta.createdAt),
		updatedAt: normalizeTime(meta.updatedAt),
	};
}

/** rlm-subagent.json stores model as "provider/id" or {provider, modelId}. */
export function normalizeModel(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const v = value as { provider?: unknown; modelId?: unknown; id?: unknown };
		const id = typeof v.modelId === "string" ? v.modelId : typeof v.id === "string" ? v.id : undefined;
		if (id) return typeof v.provider === "string" ? `${v.provider}/${id}` : id;
	}
	return undefined;
}

/** Timestamps appear as ISO strings or epoch milliseconds. */
export function normalizeTime(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return undefined;
}

async function readJsonArray(path: string): Promise<unknown[]> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (Array.isArray(parsed)) return parsed;
		if (parsed && typeof parsed === "object") {
			const jobs = (parsed as { jobs?: unknown }).jobs;
			if (Array.isArray(jobs)) return jobs;
		}
		return [];
	} catch {
		return [];
	}
}

/** Walk every session-artifacts tree below `artifactsRoot` and collect child session JSONL files (any depth). */
export async function collectChildSessionFiles(artifactsRoot: string, maxDepth = 6): Promise<string[]> {
	const found: string[] = [];
	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth) return;
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			if (name.startsWith("sub-")) {
				let inner: string[] = [];
				try {
					inner = await readdir(full);
				} catch {
					continue;
				}
				for (const f of inner) {
					if (f.endsWith(".jsonl")) found.push(join(full, f));
				}
				await walk(join(full, "session-artifacts"), depth + 1);
			} else if (depth === 0 || !name.includes(".")) {
				// <sessionId>/ directories under a session-artifacts root
				await walk(full, depth + 1);
			}
		}
	}
	await walk(artifactsRoot, 0);
	return found;
}
