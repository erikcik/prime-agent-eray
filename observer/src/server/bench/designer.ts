import type { BenchTask, Experiment, Variant } from "../../shared/bench.ts";
import type { MetaAgent } from "./meta-agent.ts";

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		variants: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: { id: { type: "string" }, name: { type: "string" }, skill: { type: "string" }, notes: { type: "string" } },
				required: ["id", "name", "skill", "notes"],
			},
		},
	},
	required: ["variants"],
};

const SYSTEM = `You design harness experiments for long-horizon AI agents. The harness is frozen; the only thing an experiment may change is context inserted at the start of a trial, written as a SKILL.md (Agent Skills format: YAML frontmatter with name and description, then markdown instructions).

Given the operator's description of the change to test and the benchmark checkpoints it will run on, write distinct implementations of that change. Each is one SKILL.md that an agent reads before continuing the task.

Rules:
- Each variant must be a genuinely different way to implement the described change (e.g. different research sources and depth, different planning granularity, a rubric self-check vs. an explicit verifier pass), not a rewording.
- Write general procedure, not answers: never include task-specific solutions, file contents, or conclusions that belong to a checkpoint's final state. The skill must be usable on new tasks in the same domain.
- Be concrete and operational: steps, sources, stopping rules, artifacts to produce, checks to run. Tool-agnostic (the agent may be prime-agent with a Python REPL or Claude Code).
- id: short kebab-case, unique. name: a few words. notes: one sentence on what distinguishes this variant.`;

export async function generateVariants(meta: MetaAgent, exp: Experiment, tasks: BenchTask[], count: number): Promise<Variant[]> {
	const taskText = tasks
		.map((t) => `### ${t.title}\ngoal: ${t.goal || "(unwritten)"}\ntags: ${t.tags.join(", ") || "-"}`)
		.join("\n\n");
	const existing = exp.variants.map((v) => `- ${v.id}: ${v.name}`).join("\n");
	const prompt = [
		`## Change to test\n${exp.title}\n\n${exp.description}`,
		`## Benchmark checkpoints it runs on\n${taskText || "(none selected yet)"}`,
		existing ? `## Variants that already exist (write different ones)\n${existing}` : "",
		`Write ${count} variant(s).`,
	]
		.filter(Boolean)
		.join("\n\n");
	const res = await meta.call<{ variants: Array<{ id: string; name: string; skill: string; notes: string }> }>({ label: `variants-${exp.id}`, system: SYSTEM, prompt, schema: SCHEMA });
	const taken = new Set(exp.variants.map((v) => v.id));
	return (res.data.variants ?? []).slice(0, count).map((v, i) => {
		let id = slug(v.id || v.name || `variant-${i + 1}`);
		while (taken.has(id)) id = `${id}-${i + 2}`;
		taken.add(id);
		return { id, name: String(v.name || id), skill: String(v.skill ?? ""), notes: String(v.notes ?? "") };
	});
}

export function slug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "variant"
	);
}
