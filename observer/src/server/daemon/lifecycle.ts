import { spawn } from "node:child_process";
import { tailLines } from "../disk/jsonl.ts";
import { daemonLogPath } from "../disk/paths.ts";
import { logger } from "../log.ts";
import type { DaemonBridge } from "./bridge.ts";

const log = logger("lifecycle");

/** How long a freshly spawned supervisor must survive before we call the start successful. */
const EARLY_EXIT_MS = 3000;

/**
 * Start a detached daemon supervisor the way the CLI's own launcher does
 * (`cli/daemon-launch.ts`: `<entrypoint> --mode daemon --daemon-socket <path>`). The old
 * `prime-agent daemon start` subcommand no longer exists. The supervisor is long-lived, so we
 * only watch for an early exit; readiness is confirmed by `ensureConnectedSoon` on the socket.
 * We never import the launcher.
 */
export function startDaemon(bin: string, socketPath: string, onLine: (line: string) => void): Promise<number> {
	return new Promise((resolve) => {
		const args = ["--mode", "daemon", "--daemon-socket", socketPath];
		log.info(`spawning ${bin} ${args.join(" ")}`);
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("PRIME_OBSERVER_")) delete env[key];
		const child = spawn(bin, args, { detached: true, stdio: "ignore", env });
		let settled = false;
		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
		child.on("error", (e) => {
			onLine(`failed to spawn ${bin}: ${e.message}`);
			settle(127);
		});
		child.on("exit", (code, signal) => {
			onLine(`daemon supervisor exited during startup (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""}); see the daemon log below`);
			settle(code ?? 1);
		});
		setTimeout(() => {
			if (settled) return;
			child.unref();
			onLine(`daemon supervisor started (pid ${child.pid})`);
			settle(0);
		}, EARLY_EXIT_MS);
	});
}

export async function daemonLogTail(logsDir: string, socketPath: string, lines: number): Promise<{ path: string; lines: string[] }> {
	const path = daemonLogPath(logsDir, socketPath);
	try {
		return { path, lines: await tailLines(path, lines) };
	} catch {
		return { path, lines: [] };
	}
}

export async function ensureConnectedSoon(bridge: DaemonBridge, timeoutMs = 15000): Promise<boolean> {
	const start = Date.now();
	bridge.poke();
	while (Date.now() - start < timeoutMs) {
		if (bridge.current?.isConnected) return true;
		await new Promise((r) => setTimeout(r, 400));
		bridge.poke();
	}
	return !!bridge.current?.isConnected;
}
