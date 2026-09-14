import type { ArmResult, BenchRun, Experiment, RunMatrixCell, RunSummary, Trial, VerifiedSkill } from "../../shared/bench.ts";

const FINISHED = new Set<Trial["status"]>(["passed", "failed", "error"]);

export function summarizeRun(run: BenchRun): RunSummary {
	const arms: ArmResult[] = run.arms.map((arm) => {
		const trials = run.trials.filter((t) => t.armId === arm.id);
		const finished = trials.filter((t) => FINISHED.has(t.status));
		const passed = finished.filter((t) => t.status === "passed").length;
		const scores = finished.map((t) => t.verdict?.score).filter((s): s is number => typeof s === "number");
		const durations = finished.map((t) => t.durationMs).filter((d): d is number => typeof d === "number");
		return {
			armId: arm.id,
			label: arm.label,
			trials: trials.length,
			finished: finished.length,
			passed,
			passRate: finished.length ? passed / finished.length : null,
			meanScore: scores.length ? mean(scores) : null,
			costUsd: trials.reduce((s, t) => s + (t.costUsd ?? 0) + (t.verdict?.costUsd ?? 0), 0),
			meanDurationMs: durations.length ? mean(durations) : null,
		};
	});
	const cells: RunMatrixCell[] = [];
	for (const taskId of run.taskIds) {
		for (const arm of run.arms) {
			const finished = run.trials.filter((t) => t.taskId === taskId && t.armId === arm.id && FINISHED.has(t.status));
			const scores = finished.map((t) => t.verdict?.score).filter((s): s is number => typeof s === "number");
			cells.push({ taskId, armId: arm.id, passed: finished.filter((t) => t.status === "passed").length, finished: finished.length, meanScore: scores.length ? mean(scores) : null });
		}
	}
	return { runId: run.id, createdAt: run.createdAt, status: run.status, arms, cells };
}

function mean(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * A variant is verified when, in the experiment's latest finished run, its arm beats the raw arm
 * of the same harness, model and memory mode by at least `minLift` pass rate. Errors count as
 * failures: a skill that crashes the agent is not an improvement.
 */
export function verifiedSkills(experiments: Experiment[], runs: BenchRun[], taskTitles: Map<string, string>, minLift: number): VerifiedSkill[] {
	const out: VerifiedSkill[] = [];
	for (const exp of experiments) {
		const run = runs.filter((r) => r.experimentId === exp.id && r.status === "done").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		if (!run) continue;
		const summary = summarizeRun(run);
		const byArm = new Map(summary.arms.map((a) => [a.armId, a]));
		for (const arm of run.arms) {
			if (!arm.variantId) continue;
			const baseline = run.arms.find((b) => b.variantId === null && b.harness === arm.harness && b.model === arm.model && b.memory === arm.memory);
			const r = byArm.get(arm.id);
			const b = baseline ? byArm.get(baseline.id) : undefined;
			if (!r || !b || r.passRate === null || b.passRate === null) continue;
			const lift = r.passRate - b.passRate;
			if (lift < minLift) continue;
			// Prefer the experiment's current variant text (edits after the run are the operator's call).
			const variant = exp.variants.find((v) => v.id === arm.variantId) ?? run.variants.find((v) => v.id === arm.variantId);
			if (!variant) continue;
			out.push({
				experimentId: exp.id,
				experimentTitle: exp.title,
				variant,
				armId: arm.id,
				lift,
				passRate: r.passRate,
				baselinePassRate: b.passRate,
				taskTitles: run.taskIds.map((id) => taskTitles.get(id) ?? id),
				runId: run.id,
			});
		}
	}
	return out.sort((a, b) => b.lift - a.lift);
}

/** Default arm set: both raw harnesses plus each variant on each harness. */
export function defaultArms(variantIds: string[], models: { primeAgent: string; claudeCode: string }, includeClaudeCode = true): Experiment["arms"] {
	const arms: Experiment["arms"] = [
		{ id: "pa-raw", label: "prime-agent · raw", harness: "prime-agent", variantId: null, model: models.primeAgent, memory: "snapshot", insertion: "system-prompt" },
	];
	if (includeClaudeCode) arms.push({ id: "cc-raw", label: "claude code · raw", harness: "claude-code", variantId: null, model: models.claudeCode, memory: "none", insertion: "system-prompt" });
	variantIds.forEach((v, i) => {
		arms.push({ id: `pa-v${i + 1}`, label: `prime-agent · ${v}`, harness: "prime-agent", variantId: v, model: models.primeAgent, memory: "snapshot", insertion: "system-prompt" });
		if (includeClaudeCode) arms.push({ id: `cc-v${i + 1}`, label: `claude code · ${v}`, harness: "claude-code", variantId: v, model: models.claudeCode, memory: "none", insertion: "system-prompt" });
	});
	return arms;
}
