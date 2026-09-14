import { createReadStream, existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	CommsResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	HealthResponse,
	MessagesPage,
	ModelsResponse,
	RewindPointsResponse,
	RewindRequest,
	RewindResponse,
	SchedulesResponse,
	SessionDetail,
} from "../../shared/api.ts";
import type { RefinementResult } from "../../shared/harness.ts";
import type { CommsIndex } from "../comms/comms-index.ts";
import type { DaemonBridge } from "../daemon/bridge.ts";
import type { DaemonCommands } from "../daemon/commands.ts";
import { type FlatTreeNode, rewindPointsForBranch } from "../daemon/rewind.ts";
import { daemonLogTail, ensureConnectedSoon, startDaemon } from "../daemon/lifecycle.ts";
import type { SessionStreamer } from "../daemon/session-streamer.ts";
import type { DeployRunner } from "../deploy/runner.ts";
import type { BindingService } from "../binding/service.ts";
import type { ModelPodService } from "../model-pod/service.ts";
import { readSessionArtifacts } from "../disk/artifacts-reader.ts";
import { buildHarnessView } from "../disk/harness-reader.ts";
import { type AgentPaths, artifactDirForSessionFile, localHarnessDir, parentArtifactDirFromChildFile } from "../disk/paths.ts";
import { readSession } from "../disk/sessions-reader.ts";
import { readSkillDoc, readSkills } from "../disk/skills-reader.ts";
import type { ObserverEnv } from "../env.ts";
import type { HtmlExporter } from "../export/html-export.ts";
import type { FleetService } from "../fleet/fleet-service.ts";
import type { Hub } from "../ws/hub.ts";
import { HttpError, type Router } from "./router.ts";
import { UPLOAD_INBOX_DIR, listInbox, receiveUpload } from "./uploads.ts";

export interface RouteDeps {
	env: ObserverEnv;
	paths: AgentPaths;
	bridge: DaemonBridge;
	commands: DaemonCommands;
	fleet: FleetService;
	streamer: SessionStreamer;
	comms: CommsIndex;
	deploy: DeployRunner;
	modelPod: ModelPodService;
	binding: BindingService;
	exporter: HtmlExporter;
	hub: Hub;
	serverStartedAt: string;
	versions: { observer: string; harness: string };
}

export function registerRoutes(r: Router, d: RouteDeps): void {
	// ---- health / daemon -------------------------------------------------------------------
	r.get("/api/health", (): HealthResponse => {
		const running = d.deploy.running;
		return {
			ok: true,
			authRequired: !!d.env.token,
			version: d.versions,
			serverStartedAt: d.serverStartedAt,
			daemon: d.bridge.info(),
			deploy: running ? { runId: running.runId, running: true } : null,
		};
	});

	r.post("/api/daemon/start", async () => {
		const lines: string[] = [];
		const code = await startDaemon(d.env.primeAgentBin, d.bridge.socketPath, (l) => {
			lines.push(l);
			d.hub.publish("daemon", { t: "deploy.log", runId: "daemon-start", line: l, stream: "out", at: new Date().toISOString() });
		});
		const connected = await ensureConnectedSoon(d.bridge);
		return { exitCode: code, connected, lines };
	});

	r.post("/api/daemon/restart", async () => {
		await d.commands.restartDaemon();
		return { ok: true };
	});

	r.post("/api/daemon/shutdown", async (ctx) => {
		const body = await ctx.body<{ force?: boolean }>();
		await d.commands.shutdownDaemon(body.force === true);
		return { ok: true };
	});

	r.get("/api/daemon/log", async (ctx) => {
		const n = Math.min(Number(ctx.query.get("lines") ?? 200), 2000);
		return daemonLogTail(d.paths.logsDir, d.bridge.socketPath, n);
	});

	// ---- fleet / sessions -----------------------------------------------------------------
	// ---- model pod (self-hosted vLLM GPU pod) ----------------------------------------------
	// Separate from /api/deploy on purpose: that redeploys the harness, this starts and stops the
	// expensive GPU that serves the local model. They have different blast radii and costs.
	r.get("/api/model-pod", () => d.modelPod.status());

	r.post("/api/model-pod/deploy", async () => {
		const s = await d.modelPod.deploy();
		d.hub.publish("deploy", { t: "deploy.log", runId: "model-pod", line: `model pod ${s.phase}${s.podId ? ` (${s.podId})` : ""}`, stream: "out", at: new Date().toISOString() });
		return s;
	});

	r.post("/api/model-pod/stop", async () => {
		const s = await d.modelPod.stop();
		d.hub.publish("deploy", { t: "deploy.log", runId: "model-pod", line: `model pod stopped`, stream: "out", at: new Date().toISOString() });
		return s;
	});

	// ---- folder binding (Mac <- /workspace) ------------------------------------------------
	// The daemon on the Mac POSTs here; the UI reads the GET. Both sit behind the same bearer
	// token as every other route, so the heartbeat cannot be forged by anything that could not
	// already drive the whole observer.
	r.get("/api/binding", () => d.binding.status());

	r.post("/api/binding/heartbeat", async (ctx) => {
		return await d.binding.accept(await ctx.body<unknown>());
	});

	r.get("/api/fleet", () => d.fleet.current());

	r.get("/api/sessions", (ctx) => {
		const scope = ctx.query.get("scope") ?? "all";
		const nodes = d.fleet.allNodes();
		if (scope === "live") return nodes.filter((n) => n.activeSessionId);
		if (scope === "saved") return nodes.filter((n) => !n.activeSessionId);
		return nodes;
	});

	r.post("/api/sessions", async (ctx): Promise<CreateSessionResponse> => {
		const body = await ctx.body<CreateSessionRequest>();
		const cwd = body.cwd?.trim();
		if (!cwd) throw new HttpError(400, "cwd is required");
		if (!existsSync(cwd)) throw new HttpError(400, `cwd does not exist: ${cwd}`, "missing_cwd");
		const summary = await d.commands.create({
			cwd,
			provider: body.provider,
			model: body.model,
			thinking: body.thinking,
			name: body.name,
			initialGoal: body.goal ? { objective: body.goal } : undefined,
		});
		if (!summary.activeSessionId) throw new HttpError(502, "daemon did not return an active session id");
		if (body.prompt?.trim()) await d.commands.prompt(summary.activeSessionId, body.prompt, { queueIfBusy: true });
		d.fleet.scheduleScan(200);
		return { activeSessionId: summary.activeSessionId, sessionId: summary.sessionId, sessionFile: summary.sessionFile };
	});

	r.post("/api/sessions/:id/resume", async (ctx): Promise<CreateSessionResponse> => {
		const node = requireNode(d, ctx.params.id ?? "");
		if (node.activeSessionId) return { activeSessionId: node.activeSessionId, sessionId: node.sessionId, sessionFile: node.sessionFile };
		if (!node.sessionFile) throw new HttpError(409, "session has no file to resume");
		const body = await ctx.body<{ cwd?: string }>();
		const summary = await d.commands.create({ cwd: body.cwd ?? node.cwd ?? d.env.repoRoot, sessionPath: node.sessionFile });
		if (!summary.activeSessionId) throw new HttpError(502, "daemon did not return an active session id");
		d.fleet.scheduleScan(200);
		return { activeSessionId: summary.activeSessionId, sessionId: summary.sessionId, sessionFile: summary.sessionFile };
	});

	r.get("/api/models", async (ctx): Promise<ModelsResponse> => {
		const requested = ctx.query.get("activeSessionId");
		const live = requested ?? d.fleet.allNodes().find((n) => n.activeSessionId)?.activeSessionId;
		if (live && d.bridge.current) {
			try {
				const res = await d.commands.getAvailableModels(live);
				const models = (res.models as Array<Record<string, unknown>>).map((m) => ({
					provider: String(m.provider ?? ""),
					id: String(m.id ?? ""),
					name: typeof m.name === "string" ? m.name : undefined,
					reasoning: m.reasoning === true,
					contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
				}));
				return { models, source: "daemon" };
			} catch {
				// fall through to disk
			}
		}
		const seen = new Map<string, ModelsResponse["models"][number]>();
		for (const n of d.fleet.allNodes()) {
			if (n.model && n.provider) {
				const id = n.model.startsWith(`${n.provider}/`) ? n.model.slice(n.provider.length + 1) : n.model;
				seen.set(`${n.provider}/${id}`, { provider: n.provider, id });
			}
		}
		return { models: [...seen.values()], source: "disk" };
	});

	r.get("/api/sessions/:id", async (ctx): Promise<SessionDetail> => {
		const node = requireNode(d, ctx.params.id ?? "");
		const live = !!node.activeSessionId && !!d.bridge.current;
		let state: unknown;
		let queue: unknown;
		if (live && node.activeSessionId) {
			try {
				state = await d.commands.getState(node.activeSessionId);
			} catch {
				state = undefined;
			}
			try {
				queue = await d.commands.getQueue(node.activeSessionId);
			} catch {
				queue = undefined;
			}
		}
		let header: Record<string, unknown> | undefined;
		let goal: unknown;
		let agentStatus: SessionDetail["agentStatus"];
		let artifacts: SessionDetail["artifacts"];
		if (node.sessionFile) {
			try {
				const parsed = await readSession(node.sessionFile);
				header = parsed.header as Record<string, unknown> | undefined;
				goal = parsed.summary.goal;
				agentStatus = parsed.summary.agentStatus;
			} catch {
				// unreadable
			}
			artifacts = await readSessionArtifacts(artifactDirFor(node) ?? artifactDirForSessionFile(node.sessionFile));
		}
		return { node, header, state, goal, agentStatus, queue, artifacts, live };
	});

	r.get("/api/sessions/:id/messages", async (ctx): Promise<MessagesPage> => {
		const node = requireNode(d, ctx.params.id ?? "");
		const limit = Math.min(Number(ctx.query.get("limit") ?? 200), 1000);
		const before = ctx.query.get("before");
		let all: unknown[] | undefined;
		let source: MessagesPage["source"] = "disk";
		if (node.activeSessionId && d.bridge.current) {
			const cached = d.streamer.cached(node.activeSessionId);
			if (cached) {
				all = cached.messages;
				source = "live";
			} else {
				try {
					all = (await d.commands.getMessages(node.activeSessionId)).messages;
					source = "live";
				} catch {
					all = undefined;
				}
			}
		}
		if (!all) {
			if (!node.sessionFile) throw new HttpError(404, "no transcript available");
			all = (await readSession(node.sessionFile)).messages;
		}
		const end = before ? Math.max(0, Math.min(Number(before), all.length)) : all.length;
		const start = Math.max(0, end - limit);
		return { messages: all.slice(start, end), hasMore: start > 0, offset: start, total: all.length, source };
	});

	r.get("/api/sessions/:id/stats", async (ctx) => {
		const node = requireNode(d, ctx.params.id ?? "");
		if (node.activeSessionId && d.bridge.current) {
			try {
				return { live: true, stats: await d.commands.getSessionStats(node.activeSessionId) };
			} catch {
				// fall through
			}
		}
		const disk = node.sessionFile ? d.fleet.diskSummary(node.sessionFile) : undefined;
		return { live: false, stats: disk ? { usage: disk.usage, messageCount: disk.messageCount, toolCallCount: disk.toolCallCount, userMessageCount: disk.userMessageCount } : null };
	});

	r.get("/api/sessions/:id/context-tree", async (ctx) => {
		const node = requireLive(d, ctx.params.id ?? "");
		return d.commands.getContextTree(node.activeSessionId);
	});

	r.get("/api/sessions/:id/children", async (ctx) => {
		const node = requireNode(d, ctx.params.id ?? "");
		if (node.activeSessionId && d.bridge.current) {
			const cached = d.streamer.cached(node.activeSessionId);
			if (cached) return { live: true, children: cached.children };
			try {
				return { live: true, children: (await d.commands.getRlmChildren(node.activeSessionId)).children };
			} catch {
				// fall through
			}
		}
		const artDir = artifactDirFor(node);
		const artifacts = artDir ? await readSessionArtifacts(artDir) : undefined;
		return { live: false, children: artifacts?.subagents ?? [], nodes: node.children };
	});

	r.get("/api/sessions/:id/harness", async (ctx) => harnessFor(d, ctx.params.id ?? ""));

	r.get("/api/sessions/:id/schedules", async (ctx) => {
		const node = requireNode(d, ctx.params.id ?? "");
		let jobs: unknown[] = [];
		if (node.activeSessionId && d.bridge.current) {
			try {
				jobs = (await d.commands.cronList(node.activeSessionId)).jobs;
			} catch {
				jobs = [];
			}
		}
		if (jobs.length === 0 && node.sessionFile) {
			const artDir = artifactDirFor(node);
			if (artDir) jobs = (await readSessionArtifacts(artDir)).scheduledJobs;
		}
		return { jobs };
	});

	r.post("/api/sessions/:id/prompt", async (ctx) => {
		const node = requireLive(d, ctx.params.id ?? "");
		const body = await ctx.body<{ message?: string; behavior?: "steer" | "followUp" }>();
		const message = body.message?.trim();
		if (!message) throw new HttpError(400, "message is required");
		await d.commands.prompt(node.activeSessionId, message, { streamingBehavior: body.behavior, queueIfBusy: true });
		return { ok: true };
	});
	r.post("/api/sessions/:id/steer", async (ctx) => {
		const node = requireLive(d, ctx.params.id ?? "");
		const body = await ctx.body<{ message?: string }>();
		if (!body.message?.trim()) throw new HttpError(400, "message is required");
		await d.commands.steer(node.activeSessionId, body.message);
		return { ok: true };
	});
	r.post("/api/sessions/:id/follow-up", async (ctx) => {
		const node = requireLive(d, ctx.params.id ?? "");
		const body = await ctx.body<{ message?: string }>();
		if (!body.message?.trim()) throw new HttpError(400, "message is required");
		await d.commands.followUp(node.activeSessionId, body.message);
		return { ok: true };
	});
	r.post("/api/sessions/:id/abort", async (ctx) => {
		const node = requireLive(d, ctx.params.id ?? "");
		await d.commands.abort(node.activeSessionId);
		return { ok: true };
	});
	r.post("/api/sessions/:id/kill", async (ctx) => {
		const node = requireLive(d, ctx.params.id ?? "");
		await d.commands.kill(node.activeSessionId);
		d.fleet.scheduleScan(500);
		return { ok: true };
	});
	r.post("/api/sessions/:id/message", async (ctx) => {
		// Send an agent message *to* this session from another live session (the sender).
		const target = requireLive(d, ctx.params.id ?? "");
		const body = await ctx.body<{ message?: string; fromActiveSessionId?: string }>();
		if (!body.message?.trim()) throw new HttpError(400, "message is required");
		const sender = body.fromActiveSessionId ?? d.fleet.allNodes().find((n) => n.activeSessionId && n.activeSessionId !== target.activeSessionId)?.activeSessionId;
		if (!sender) throw new HttpError(409, "no other live session available to send from", "no_sender");
		await d.commands.sendMessage(sender, target.activeSessionId, body.message);
		return { ok: true, from: sender };
	});

	// ---- rewind ----------------------------------------------------------------------------
	// Claude Code's Esc-Esc: list the user messages on the current branch, pick one, and the
	// harness moves the session leaf to just before it (navigate_tree). Nothing is deleted:
	// the abandoned turns stay in the session file as a sibling branch, optionally summarized.
	r.get("/api/sessions/:id/rewind-points", async (ctx): Promise<RewindPointsResponse> => {
		const activeSessionId = requireLiveId(d, ctx.params.id ?? "", ctx.query.get("activeSessionId") ?? undefined);
		const tree = await d.commands.getSessionTree(activeSessionId);
		return { points: rewindPointsForBranch(tree.flatNodes as FlatTreeNode[], tree.leafId), leafId: tree.leafId, activeSessionId };
	});

	r.post("/api/sessions/:id/rewind", async (ctx): Promise<RewindResponse> => {
		const body = await ctx.body<RewindRequest>();
		if (!body.entryId?.trim()) throw new HttpError(400, "entryId is required");
		const activeSessionId = requireLiveId(d, ctx.params.id ?? "", body.activeSessionId);
		const result = await d.commands.navigateTree(activeSessionId, body.entryId, { summarize: body.summarize === true });
		if (!result.cancelled) {
			// The daemon does not necessarily replay a snapshot to watchers after a branch change,
			// so refresh every open viewer from the source of truth rather than trusting an event.
			try {
				const [state, messages] = await Promise.all([d.commands.getState(activeSessionId), d.commands.getMessages(activeSessionId)]);
				d.streamer.replace(activeSessionId, state, messages.messages);
			} catch {
				// Viewers will pick it up on their next snapshot; the rewind itself succeeded.
			}
		}
		return { ok: true, cancelled: result.cancelled, aborted: result.aborted, editorText: result.editorText, summarized: !!result.summaryEntry };
	});

	r.post("/api/sessions/:id/export.html", async (ctx) => {
		const node = requireNode(d, ctx.params.id ?? "");
		let path: string;
		if (node.activeSessionId && d.bridge.current) path = await d.exporter.exportLive(d.commands, node.activeSessionId);
		else if (node.sessionFile) path = await d.exporter.exportSaved(node.sessionFile);
		else throw new HttpError(404, "nothing to export");
		return { downloadPath: `/api/exports/${encodeURIComponent(basename(path))}`, path };
	});

	r.get("/api/exports/:file", async (ctx) => {
		const name = basename(ctx.params.file ?? "");
		const file = join(d.env.dataDir, "exports", name);
		if (!name.endsWith(".html") || !existsSync(file)) throw new HttpError(404, "export not found");
		const st = await stat(file);
		ctx.res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-length": st.size,
			"content-disposition": `attachment; filename="${name}"`,
			"cache-control": "no-store",
		});
		await new Promise<void>((resolve, reject) => {
			createReadStream(file).on("error", reject).on("end", resolve).pipe(ctx.res);
		});
		void unlink(file).catch(() => undefined);
	});

	// ---- harness / skills ------------------------------------------------------------------
	r.get("/api/harness", async (ctx) => {
		const session = ctx.query.get("session");
		if (session) return harnessFor(d, session);
		const refinements = await collectSessionRefinements(d);
		return buildHarnessView({ globalDir: d.paths.globalHarnessDir, sessionRefinements: refinements });
	});

	r.get("/api/harness/history", async (ctx) => {
		const session = ctx.query.get("session");
		const view = session ? await harnessFor(d, session) : await buildHarnessView({ globalDir: d.paths.globalHarnessDir, sessionRefinements: await collectSessionRefinements(d) });
		return view.history;
	});

	r.post("/api/harness/rollback", async (ctx) => {
		const body = await ctx.body<{ refinementId?: string; activeSessionId?: string }>();
		if (!body.refinementId) throw new HttpError(400, "refinementId is required");
		const history = await buildHarnessView({ globalDir: d.paths.globalHarnessDir, sessionRefinements: await collectSessionRefinements(d) });
		const target = history.history.find((h) => h.id === body.refinementId);
		if (!target) throw new HttpError(404, "refinement not found");
		const global = target.scope !== "local";
		let activeSessionId = body.activeSessionId;
		if (!activeSessionId) {
			if (global) activeSessionId = d.fleet.allNodes().find((n) => n.activeSessionId)?.activeSessionId;
			else if (target.sessionId) activeSessionId = d.fleet.findNode(target.sessionId)?.activeSessionId;
		}
		if (!activeSessionId) {
			const owner = target.sessionId ? d.fleet.findNode(target.sessionId) : undefined;
			throw new HttpError(409, global ? "no live session available to apply a global rollback" : "the owning session is not live", "session_not_live", {
				sessionId: target.sessionId,
				sessionFile: owner?.sessionFile,
			});
		}
		const result = await d.commands.refine(activeSessionId, { rollbackId: body.refinementId, global });
		d.hub.publish("harness", { t: "harness.changed", scope: global ? "global" : "local", sessionId: target.sessionId });
		return { ok: true, result };
	});

	r.post("/api/harness/refine", async (ctx) => {
		const body = await ctx.body<{ activeSessionId?: string; instructions?: string; global?: boolean }>();
		if (!body.activeSessionId) throw new HttpError(400, "activeSessionId is required");
		const result = await d.commands.refine(body.activeSessionId, { instructions: body.instructions, global: body.global });
		d.hub.publish("harness", { t: "harness.changed", scope: body.global ? "global" : "local" });
		return { ok: true, result };
	});

	// ---- asset uploads ---------------------------------------------------------------
	// Files land in `<session cwd>/inbox/` and the composer announces them by relative path.
	// `receiveUpload` streams the raw body to disk; it never touches ctx.body(), whose 4 MB
	// in-memory cap is meant for control JSON. See uploads.ts for why that matters.
	const uploadCwd = (ctx: { query: URLSearchParams }): string => {
		const session = ctx.query.get("session");
		if (session) {
			const node = d.fleet.findNode(session);
			if (node?.cwd && existsSync(node.cwd)) return node.cwd;
		}
		const cwd = ctx.query.get("cwd");
		if (cwd && existsSync(cwd)) return cwd;
		return d.env.repoRoot;
	};

	r.get("/api/uploads", (ctx) => ({ cwd: uploadCwd(ctx), inbox: UPLOAD_INBOX_DIR, files: listInbox(uploadCwd(ctx)) }));

	r.post("/api/uploads", async (ctx) => {
		const cwd = uploadCwd(ctx);
		const header = ctx.req.headers["x-file-name"];
		const file = await receiveUpload(ctx.req, {
			cwd,
			fileName: Array.isArray(header) ? header[0] : header,
			maxBytes: d.env.maxUploadBytes,
		});
		d.hub.publish("uploads", { t: "uploads.changed", cwd });
		return { ok: true, file };
	});

	r.get("/api/skills", (ctx) => {
		const cwd = ctx.query.get("cwd") ?? d.env.repoRoot;
		return readSkills(existsSync(cwd) ? cwd : d.env.repoRoot, d.paths.agentDir, d.env.repoRoot);
	});

	r.get("/api/skills/:name/doc", async (ctx) => {
		const cwd = ctx.query.get("cwd") ?? d.env.repoRoot;
		const { skills } = readSkills(existsSync(cwd) ? cwd : d.env.repoRoot, d.paths.agentDir, d.env.repoRoot);
		const skill = skills.find((s) => s.name === ctx.params.name);
		if (!skill) throw new HttpError(404, "skill not found");
		const pyproject = skill.kind === "python" ? join(skill.baseDir, "pyproject.toml") : undefined;
		return readSkillDoc(skill, pyproject);
	});

	// ---- schedules / comms -----------------------------------------------------------------
	r.get("/api/schedules", async (): Promise<SchedulesResponse> => {
		let cron: unknown[] = [];
		let heartbeats: unknown[] = [];
		if (d.bridge.current) {
			try {
				cron = (await d.commands.cronList(undefined, true)).jobs;
			} catch {
				cron = [];
			}
			try {
				heartbeats = (await d.commands.heartbeatsList()).heartbeats;
			} catch {
				heartbeats = [];
			}
		}
		const offline: SchedulesResponse["offline"] = [];
		for (const n of d.fleet.allNodes()) {
			if (n.activeSessionId || !n.sessionFile) continue;
			const artDir = artifactDirFor(n);
			if (!artDir) continue;
			const art = await readSessionArtifacts(artDir);
			if (art.scheduledJobs.length) offline.push({ sessionId: n.sessionId, jobs: art.scheduledJobs });
		}
		return { cron, heartbeats, offline };
	});

	r.get("/api/comms", async (ctx): Promise<CommsResponse> => {
		const session = ctx.query.get("session");
		const limit = Math.min(Number(ctx.query.get("limit") ?? 300), 2000);
		let files = d.fleet.sessionFiles();
		if (session) {
			const node = d.fleet.findNode(session);
			files = node?.sessionFile ? [node.sessionFile, ...node.children.map((c) => c.sessionFile).filter((f): f is string => !!f)] : [];
		}
		const records = await d.comms.collect(files, limit);
		let status: CommsResponse["status"];
		const live = session ? d.fleet.findNode(session)?.activeSessionId : undefined;
		if (live && d.bridge.current) {
			try {
				status = (await d.commands.agentMessagesStatus(live)) as CommsResponse["status"];
			} catch {
				status = undefined;
			}
		}
		return { records, status };
	});

	// ---- deploy ----------------------------------------------------------------------------
	r.post("/api/deploy", (ctx) => {
		const run = d.deploy.start();
		ctx.res.statusCode = 202;
		return { runId: run.runId };
	});
	r.get("/api/deploy/last", async () => (await d.deploy.last()) ?? null);
}

/**
 * Artifact dir for a node: the harness formula first; if that dir does not exist but a child
 * session file is known (ledger), derive it from the child path (print-mode sessions can persist
 * artifacts under a different id than their transcript).
 */
function artifactDirFor(node: { sessionFile?: string; children: Array<{ sessionFile?: string }> }): string | undefined {
	if (node.sessionFile) {
		const formula = artifactDirForSessionFile(node.sessionFile);
		if (existsSync(formula)) return formula;
	}
	const child = node.children.find((c) => c.sessionFile);
	if (child?.sessionFile) return parentArtifactDirFromChildFile(child.sessionFile);
	return node.sessionFile ? artifactDirForSessionFile(node.sessionFile) : undefined;
}

function requireNode(d: RouteDeps, id: string) {
	const node = d.fleet.findNode(id);
	if (!node) throw new HttpError(404, `unknown session ${id}`);
	return node;
}

/**
 * The live id for a session, accepting a caller-supplied one for the window right after a
 * resume when the fleet scan has not yet attached activeSessionId to the node.
 */
function requireLiveId(d: RouteDeps, id: string, override?: string): string {
	const node = requireNode(d, id);
	if (!d.bridge.current) throw new HttpError(503, "daemon offline", "daemon_offline");
	const live = node.activeSessionId ?? override?.trim();
	if (!live) throw new HttpError(409, "session is not live; resume it first", "session_not_live", { sessionFile: node.sessionFile });
	return live;
}

function requireLive(d: RouteDeps, id: string) {
	const node = requireNode(d, id);
	if (!node.activeSessionId) throw new HttpError(409, "session is not live; resume it first", "session_not_live", { sessionFile: node.sessionFile });
	if (!d.bridge.current) throw new HttpError(503, "daemon offline", "daemon_offline");
	return node as typeof node & { activeSessionId: string };
}

async function harnessFor(d: RouteDeps, id: string) {
	const node = requireNode(d, id);
	const artDir = artifactDirFor(node);
	const localDir = artDir ? localHarnessDir(artDir) : undefined;
	const refinements = node.sessionFile ? (await readSession(node.sessionFile)).summary.refinements : [];
	return buildHarnessView({ globalDir: d.paths.globalHarnessDir, localDir, sessionId: node.sessionId, sessionRefinements: refinements });
}

async function collectSessionRefinements(d: RouteDeps): Promise<RefinementResult[]> {
	const out: RefinementResult[] = [];
	for (const file of d.fleet.sessionFiles()) {
		const s = d.fleet.diskSummary(file);
		if (s) out.push(...s.refinements);
	}
	return out;
}
