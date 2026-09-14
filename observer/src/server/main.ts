import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { VERSION as HARNESS_VERSION } from "@earendil-works/pi-coding-agent";
import { TERM_WS_PATH, type ServerMessage } from "../shared/ws.ts";
import { hasQueryToken, httpAuthorized } from "./auth.ts";
import { CommsIndex } from "./comms/comms-index.ts";
import { DaemonBridge } from "./daemon/bridge.ts";
import { DaemonCommands } from "./daemon/commands.ts";
import { SessionStreamer } from "./daemon/session-streamer.ts";
import { DeployRunner, RESTART_EXIT_CODE } from "./deploy/runner.ts";
import { BindingService } from "./binding/service.ts";
import { ModelPodService } from "./model-pod/service.ts";
import { agentPaths } from "./disk/paths.ts";
import { AgentDirWatcher } from "./disk/watcher.ts";
import { loadEnv } from "./env.ts";
import { HtmlExporter } from "./export/html-export.ts";
import { FleetService } from "./fleet/fleet-service.ts";
import { Router, sendJson } from "./http/router.ts";
import { TerminalHub } from "./terminal/terminal-hub.ts";
import { registerRoutes } from "./http/routes.ts";
import { serveStatic } from "./http/static.ts";
import { logger } from "./log.ts";
import { Hub } from "./ws/hub.ts";

const log = logger("main");

export async function startServer(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<{ close: () => Promise<void>; port: number }> {
	const env = loadEnv({ ...process.env, ...overrides });
	const serverStartedAt = new Date().toISOString();
	const observerVersion = readObserverVersion(env.observerRoot);
	mkdirSync(env.dataDir, { recursive: true });
	const paths = agentPaths(env.agentDir, process.env.PRIME_AGENT_SESSION_DIR || undefined);

	const bridge = new DaemonBridge(env.daemonSocket);
	const commands = new DaemonCommands(bridge);
	const watcher = new AgentDirWatcher({
		sessions: paths.sessionsDir,
		artifacts: paths.artifactsRoot,
		ledger: paths.ledgerDir,
		harness: paths.globalHarnessDir,
		skills: paths.skillsDir,
	});
	const fleet = new FleetService(bridge, paths, watcher);
	const streamer = new SessionStreamer(bridge);
	const comms = new CommsIndex();
	const exporter = new HtmlExporter(env.repoRoot, join(env.dataDir, "exports"));

	let shuttingDown = false;
	const hub = new Hub({
		token: env.token,
		insecureLocal: env.insecureLocal,
		allowedOrigins: env.allowedOrigins,
		serverStartedAt,
		version: observerVersion,
		subscribeSession: async (activeSessionId, send) => {
			const node = fleet.findNode(activeSessionId);
			const sessionId = node?.sessionId ?? activeSessionId;
			return streamer.subscribe(activeSessionId, (ev) => {
				switch (ev.kind) {
					case "snapshot":
						send({ t: "session.snapshot", activeSessionId, snapshot: ev.snapshot });
						break;
					case "event": {
						const e = ev.event as { type?: string; message?: Record<string, unknown> };
						if (e.type === "ipython_sent_agent_message" && e.message) {
							const rec = comms.recordSent(sessionId, activeSessionId, e.message);
							hub.publish("comms", { t: "comms.message", record: rec });
						}
						send({ t: "session.event", activeSessionId, event: ev.event });
						break;
					}
					case "status":
						send({ t: "session.status", activeSessionId, recap: ev.recap });
						break;
					case "connection":
						send({ t: "session.connection", activeSessionId, status: ev.status });
						break;
					case "children":
						send({ t: "session.children", activeSessionId, children: ev.children });
						break;
					case "closed":
						send({ t: "session.closed", activeSessionId, reason: ev.reason });
						break;
				}
			});
		},
		onFirstSubscribe: (topic, send) => {
			if (topic === "fleet") send({ t: "fleet.snapshot", tree: fleet.current() });
			if (topic === "daemon") send({ t: "daemon.state", daemon: bridge.info() });
		},
	});

	// The session page hosts the real TUI: one PTY per open terminal, resuming the session file.
	const terminals = new TerminalHub({
		token: env.token,
		insecureLocal: env.insecureLocal,
		allowedOrigins: env.allowedOrigins,
		primeAgentBin: env.primeAgentBin,
		daemonSocket: env.daemonSocket,
		agentDir: env.agentDir,
		fallbackCwd: env.repoRoot,
		resolveTarget: (id) => {
			const node = fleet.findNode(id);
			return node?.sessionFile ? { sessionFile: node.sessionFile, cwd: node.cwd } : undefined;
		},
	});

	const deploy = new DeployRunner({
		hookPath: env.deployHook,
		repoRoot: env.repoRoot,
		dataDir: env.dataDir,
		port: env.port,
		agentDir: env.agentDir,
		onStarted: (runId) => hub.publish("deploy", { t: "deploy.started", runId }),
		onLine: (runId, line, stream) => hub.publish("deploy", { t: "deploy.log", runId, line, stream, at: new Date().toISOString() }),
		onDone: (runId, exitCode, willRestart) => hub.publish("deploy", { t: "deploy.done", runId, exitCode, willRestart }),
		requestRestart: () => {
			log.info(`deploy succeeded; exiting with ${RESTART_EXIT_CODE} for the supervisor to restart`);
			void shutdown(RESTART_EXIT_CODE);
		},
	});

	// The GPU pod that serves the self-hosted model. Its log lines ride the existing "deploy" topic
	// so the Ops console shows model-pod progress without a second WebSocket channel.
	const modelPod = new ModelPodService({
		repoRoot: env.repoRoot,
		dataDir: env.dataDir,
		agentDir: env.agentDir,
		apiKey: process.env.VLLM_API_KEY,
		onLine: (line) => hub.publish("deploy", { t: "deploy.log", runId: "model-pod", line, stream: "out", at: new Date().toISOString() }),
	});

	// The Mac folder binding. Purely a receiver: the daemon on the Mac calls in, because the
	// observer has no route back to a laptop behind a home NAT.
	const binding = new BindingService({ dataDir: env.dataDir });

	fleet.onTree((tree) => hub.publish("fleet", { t: "fleet.snapshot", tree }));
	bridge.subscribe({ onState: (info) => hub.publish("daemon", { t: "daemon.state", daemon: info }) });
	watcher.onChange((events) => {
		if (events.some((e) => e.area === "harness")) hub.publish("harness", { t: "harness.changed", scope: "global" });
		if (events.some((e) => e.area === "artifacts" && e.path.includes("/harness/"))) hub.publish("harness", { t: "harness.changed", scope: "local" });
		if (events.some((e) => e.path.endsWith("scheduled-jobs.json"))) hub.publish("schedules", { t: "schedules.changed" });
	});

	const router = new Router();
	registerRoutes(router, {
		env,
		paths,
		bridge,
		commands,
		fleet,
		streamer,
		comms,
		deploy,
		modelPod,
		binding,
		exporter,
		hub,
		serverStartedAt,
		versions: { observer: observerVersion, harness: HARNESS_VERSION },
	});

	const server = createServer(async (req, res) => {
		const url = req.url ?? "/";
		if (url.startsWith("/api/")) {
			if (hasQueryToken(url)) {
				sendJson(res, 400, { error: "tokens in query strings are not accepted" });
				return;
			}
			if (!url.startsWith("/api/health") && !httpAuthorized(req, env)) {
				res.setHeader("www-authenticate", "Bearer");
				sendJson(res, 401, { error: "invalid or missing bearer token", code: "unauthorized" });
				return;
			}
			const handled = await router.dispatch(req, res);
			if (!handled) sendJson(res, 404, { error: "not found" });
			return;
		}
		serveStatic(env.webDist, req, res);
	});
	// Node caps a whole request at `requestTimeout` (300 s by default) and the header phase at
	// `headersTimeout` (60 s). An attachment pushed over a slow uplink routinely takes longer than
	// five minutes, and the socket is then torn down mid-body: the browser reports a network error
	// with no status, so it reads as "uploads time out" rather than as a server limit. Uploads
	// stream to disk and are byte-capped in uploads.ts, so time is the wrong axis to police here.
	server.requestTimeout = 0; // no ceiling on body duration; size is bounded instead
	server.headersTimeout = 60_000; // still bound the header phase (slowloris)
	server.keepAliveTimeout = 72_000;

	server.on("upgrade", (req, socket, head) => {
		const path = (req.url ?? "").split("?")[0];
		if (path === "/ws") hub.handleUpgrade(req, socket, head as Buffer);
		else if (path === TERM_WS_PATH) terminals.handleUpgrade(req, socket, head as Buffer);
		else socket.destroy();
	});

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		hub.closeAll(1012, "restarting");
		terminals.closeAll(1012, "restarting");
		watcher.stop();
		bridge.stop();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		setTimeout(() => process.exit(exitCode), 200);
	}

	process.on("SIGTERM", () => void shutdown(0));
	process.on("SIGINT", () => void shutdown(0));

	watcher.start();
	bridge.start();
	await fleet.start();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(env.port, env.host, () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : env.port;
	// With PRIME_OBSERVER_PORT=0 the real port is only known now; allow the loopback origins for it.
	env.allowedOrigins.add(`http://localhost:${port}`);
	env.allowedOrigins.add(`http://127.0.0.1:${port}`);
	log.info(`prime observer ${observerVersion} listening on http://${env.host}:${port}/ (agent dir ${env.agentDir}, socket ${bridge.socketPath})`);
	log.info(`allowed origins: ${[...env.allowedOrigins].join(", ")}`);
	return { close: () => shutdown(0), port };
}

function readObserverVersion(observerRoot: string): string {
	try {
		return (JSON.parse(readFileSync(join(observerRoot, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const isMain = process.argv[1] && /main\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
	startServer().catch((e) => {
		log.error("failed to start", e);
		process.exit(1);
	});
}
