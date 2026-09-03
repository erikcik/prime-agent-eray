import { spawn } from "node:child_process";
import { tailLines } from "../disk/jsonl.ts";
import { daemonLogPath } from "../disk/paths.ts";
import { logger } from "../log.ts";
import type { DaemonBridge } from "./bridge.ts";

const log = logger("lifecycle");

/**
 * Start the daemon by shelling out to the Prime Agent CLI (`prime-agent daemon start`), which
 * spawns a detached supervisor and polls the socket. We never import the launcher.
 */
export function startDaemon(bin: string, socketPath: string, onLine: (line: string) => void): Promise<number> {
	return new Promise((resolve) => {
		const args = ["daemon", "start", "--socket", socketPath];
		log.info(`spawning ${bin} ${args.join(" ")}`);
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
		const forward = (buf: Buffer) => {
			for (const line of buf.toString("utf8").split("\n")) if (line.trim()) onLine(line);
		};
		child.stdout.on("data", forward);
		child.stderr.on("data", forward);
		child.on("error", (e) => {
			onLine(`failed to spawn ${bin}: ${e.message}`);
			resolve(127);
		});
		child.on("exit", (code) => resolve(code ?? 1));
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
