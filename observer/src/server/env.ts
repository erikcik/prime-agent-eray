import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ObserverEnv {
	port: number;
	host: string;
	token: string | undefined;
	insecureLocal: boolean;
	allowedOrigins: Set<string>;
	agentDir: string;
	daemonSocket: string | undefined;
	deployHook: string;
	primeAgentBin: string;
	repoRoot: string;
	observerRoot: string;
	webDist: string;
	dataDir: string;
	isDev: boolean;
	/** Cap for one composer attachment. Through the RunPod proxy Cloudflare rejects >~100 MB first. */
	maxUploadBytes: number;
	/** Stop the RunPod pod after this many idle minutes; 0 disables. Only active on a pod with an API key. */
	idleStopMinutes: number;
}

/** Attachment cap; env override must be a positive integer or we keep the default. */
export const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const n = Number.parseInt((value ?? "").trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_IDLE_STOP_MINUTES = 30;

function parseIdleMinutes(value: string | undefined): number {
	const n = Number.parseInt((value ?? "").trim(), 10);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_STOP_MINUTES;
}

function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function deriveAllowedOrigins(env: NodeJS.ProcessEnv, port: number): Set<string> {
	const origins = new Set<string>();
	origins.add(`http://localhost:${port}`);
	origins.add(`http://127.0.0.1:${port}`);
	for (const o of parseList(env.PRIME_OBSERVER_ALLOWED_ORIGINS)) origins.add(o.replace(/\/$/, ""));
	if (env.RUNPOD_POD_ID) origins.add(`https://${env.RUNPOD_POD_ID}-${port}.proxy.runpod.net`);
	if (env.NODE_ENV === "development") {
		origins.add("http://localhost:5173");
		origins.add("http://127.0.0.1:5173");
	}
	return origins;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ObserverEnv {
	const observerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	// dist/server/env.js -> observer/ ; src/server/env.ts -> observer/ as well (both two levels up).
	const repoRoot = env.PRIME_OBSERVER_REPO_ROOT ? resolve(env.PRIME_OBSERVER_REPO_ROOT) : resolve(observerRoot, "..");
	const port = Number(env.PRIME_OBSERVER_PORT ?? 8790);
	const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR
		? resolve(env.PRIME_AGENT_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, homedir()))
		: resolve(homedir(), ".prime", "agent");
	const token = env.PRIME_OBSERVER_TOKEN?.trim() || undefined;
	const host = env.PRIME_OBSERVER_HOST ?? "127.0.0.1";
	const insecureLocal = env.PRIME_OBSERVER_INSECURE_LOCAL === "1";
	const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
	if (!token && !(insecureLocal && loopback)) {
		throw new Error(
			"PRIME_OBSERVER_TOKEN is required (>=16 chars). For a loopback-only dev server set PRIME_OBSERVER_INSECURE_LOCAL=1.",
		);
	}
	if (token && token.length < 16) throw new Error("PRIME_OBSERVER_TOKEN must be at least 16 characters.");
	const webDist = resolve(observerRoot, "dist", "web");
	return {
		port,
		host,
		token,
		insecureLocal,
		allowedOrigins: deriveAllowedOrigins(env, port),
		agentDir,
		daemonSocket: env.PRIME_AGENT_DAEMON_SOCKET || undefined,
		deployHook: env.PRIME_OBSERVER_DEPLOY_HOOK ?? resolve(repoRoot, "deploy", "refresh.sh"),
		primeAgentBin: env.PRIME_OBSERVER_PRIME_AGENT_BIN ?? "prime-agent",
		repoRoot,
		observerRoot,
		webDist: existsSync(webDist) ? webDist : webDist,
		dataDir: resolve(agentDir, "observer"),
		isDev: env.NODE_ENV === "development",
		maxUploadBytes: parsePositiveInt(env.PRIME_OBSERVER_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
		idleStopMinutes: parseIdleMinutes(env.PRIME_OBSERVER_IDLE_STOP_MINUTES),
	};
}
