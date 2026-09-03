import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { SkillDoc, SkillSummary } from "../../shared/harness.ts";

export interface SkillsResult {
	skills: SkillSummary[];
	diagnostics: unknown[];
}

/**
 * Uses the harness's public loadSkills()/loadSkillsFromDir() (packages/coding-agent/src/core/skills.ts).
 * loadSkills covers <agentDir>/skills (user) and <cwd>/.prime/agent/skills (project); we add the
 * bundled skills shipped with the harness and the shared ~/.agents/skills directory, deduplicated by name.
 */
export function readSkills(cwd: string, agentDir: string, repoRoot?: string): SkillsResult {
	const result = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
	const skills = new Map<string, SkillSummary>();
	const diagnostics: unknown[] = [...(result.diagnostics as unknown[])];
	const add = (list: unknown[], sourceOverride?: string) => {
		for (const raw of list) {
			const s = toSummary(raw, sourceOverride);
			if (!skills.has(s.name)) skills.set(s.name, s);
		}
	};
	add(result.skills as unknown[]);
	const extra: Array<{ dir: string; source: string }> = [{ dir: join(homedir(), ".agents", "skills"), source: "agents" }];
	if (repoRoot) {
		const dist = join(repoRoot, "packages", "coding-agent", "dist", "skills");
		const src = join(repoRoot, "packages", "coding-agent", "skills");
		extra.push({ dir: existsSync(dist) ? dist : src, source: "bundled" });
	}
	for (const { dir, source } of extra) {
		if (!existsSync(dir)) continue;
		try {
			const r = loadSkillsFromDir({ dir, source } as never);
			add(r.skills as unknown[], source);
			diagnostics.push(...(r.diagnostics as unknown[]));
		} catch (e) {
			diagnostics.push({ type: "warning", message: `failed to load ${dir}: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

function toSummary(raw: unknown, sourceOverride?: string): SkillSummary {
	const r = raw as Record<string, unknown>;
	const python = r.python as { importName?: string } | undefined;
	return {
		name: String(r.name ?? ""),
		description: String(r.description ?? ""),
		kind: String(r.kind ?? "markdown"),
		source: sourceOverride ?? String(r.source ?? ""),
		filePath: String(r.filePath ?? ""),
		baseDir: String(r.baseDir ?? ""),
		disableModelInvocation: r.disableModelInvocation === true,
		importName: python?.importName,
		license: typeof r.license === "string" ? r.license : undefined,
		metadata: r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : undefined,
	};
}

export async function readSkillDoc(skill: SkillSummary, pyprojectPath?: string): Promise<SkillDoc> {
	const markdown = await readFile(skill.filePath, "utf8");
	let pyproject: string | undefined;
	if (pyprojectPath) {
		try {
			pyproject = await readFile(pyprojectPath, "utf8");
		} catch {
			pyproject = undefined;
		}
	}
	return { name: skill.name, markdown, pyproject, filePath: skill.filePath };
}
