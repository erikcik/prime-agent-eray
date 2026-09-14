import type { BenchSettings, BenchTask, CaptureRequest, Experiment } from "../../shared/bench.ts";
import type { BenchService, CreateExperimentInput } from "../bench/service.ts";
import { HttpError, type Router } from "./router.ts";

export function registerBenchRoutes(r: Router, bench: BenchService): void {
	r.get("/api/bench", () => bench.overview());

	r.get("/api/bench/settings", () => bench.store.settings());
	r.post("/api/bench/settings", async (ctx) => bench.saveSettings(await ctx.body<Partial<BenchSettings>>()));

	// ---- sessions as capture sources -----------------------------------------------------------
	r.get("/api/bench/sessions/:id/timeline", (ctx) => bench.sessionTimeline(ctx.params.id!));

	r.get("/api/bench/sessions/:id/entries/:entryId/images/:index", async (ctx) => {
		const img = await bench.entryImage(ctx.params.id!, ctx.params.entryId!, Number(ctx.params.index));
		if (!img) throw new HttpError(404, "no image at that position");
		ctx.res.writeHead(200, { "content-type": img.mimeType, "content-length": img.data.length, "cache-control": "private, max-age=3600" });
		ctx.res.end(img.data);
	});

	// ---- tasks ------------------------------------------------------------------------------------
	r.post("/api/bench/tasks/capture", async (ctx) => {
		const body = await ctx.body<CaptureRequest>();
		if (!body.sessionId) throw new HttpError(422, "sessionId is required");
		return bench.capture(body);
	});
	r.get("/api/bench/tasks/:id", (ctx) => bench.taskDetail(ctx.params.id!));
	r.post("/api/bench/tasks/:id", async (ctx) => bench.updateTask(ctx.params.id!, await ctx.body<Partial<BenchTask>>()));
	r.delete("/api/bench/tasks/:id", (ctx) => {
		bench.deleteTask(ctx.params.id!);
		return { ok: true };
	});

	// ---- candidates (trajectory miner) -----------------------------------------------------------
	r.post("/api/bench/candidates/mine", async (ctx) => {
		const body = await ctx.body<{ sessionId?: string }>();
		if (!body.sessionId) throw new HttpError(422, "sessionId is required");
		return bench.mine(body.sessionId);
	});
	r.post("/api/bench/candidates/:id/accept", async (ctx) => bench.acceptCandidate(ctx.params.id!, await ctx.body<{ desiredTrajectory?: string; title?: string }>()));
	r.post("/api/bench/candidates/:id/reject", (ctx) => {
		bench.rejectCandidate(ctx.params.id!);
		return { ok: true };
	});

	// ---- experiments + runs ----------------------------------------------------------------------
	r.post("/api/bench/experiments", async (ctx) => bench.createExperiment(await ctx.body<CreateExperimentInput>()));
	r.get("/api/bench/experiments/:id", (ctx) => {
		const experiment = bench.store.getExperiment(ctx.params.id!);
		if (!experiment) throw new HttpError(404, "experiment not found");
		const runs = bench.overview().runs.filter((s) => bench.store.getRun(s.runId)?.experimentId === experiment.id);
		return { experiment, runs, active: bench.runner.isActive(experiment.id) };
	});
	r.post("/api/bench/experiments/:id", async (ctx) => bench.updateExperiment(ctx.params.id!, await ctx.body<Partial<Experiment>>()));
	r.delete("/api/bench/experiments/:id", (ctx) => {
		bench.deleteExperiment(ctx.params.id!);
		return { ok: true };
	});
	r.post("/api/bench/experiments/:id/variants/generate", async (ctx) => {
		const body = await ctx.body<{ count?: number }>();
		return bench.generateVariantsJob(ctx.params.id!, Math.min(6, Math.max(1, Number(body.count ?? 1))));
	});
	r.post("/api/bench/experiments/:id/variants/:variantId/promote", (ctx) => bench.promoteVariant(ctx.params.id!, ctx.params.variantId!));
	r.post("/api/bench/experiments/:id/run", async (ctx) => bench.startRun(ctx.params.id!, await ctx.body<{ taskIds?: string[]; armIds?: string[]; repeats?: number }>()));

	r.get("/api/bench/runs/:id", (ctx) => bench.runDetail(ctx.params.id!));
	r.post("/api/bench/runs/:id/cancel", (ctx) => {
		bench.cancelRun(ctx.params.id!);
		return { ok: true };
	});
	r.get("/api/bench/runs/:id/trials/:trialId/rows", (ctx) => ({ rows: bench.trialRows(ctx.params.id!, ctx.params.trialId!) }));

	// ---- advisor ---------------------------------------------------------------------------------
	r.get("/api/bench/advisor", () => ({ events: bench.advisor.events(), verified: bench.verified(), live: bench.liveSessions() }));
	r.post("/api/bench/advisor/check", async (ctx) => {
		const body = await ctx.body<{ sessionId?: string }>();
		if (!body.sessionId) throw new HttpError(422, "sessionId is required");
		return { event: await bench.advisorCheck(body.sessionId) };
	});
	r.post("/api/bench/advisor/events/:id/send", (ctx) => bench.advisorSend(ctx.params.id!));
}
