import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DaemonClient } from "@earendil-works/pi-coding-agent";
import { logger } from "../log.ts";

const log = logger("bench-proc");

export interface ProcResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	cancelled: boolean;
	stderrTail: string;
}

export interface ProcHandle {
	pid: number | undefined;
	done: Promise<ProcResult>;
	cancel(): void;
}

/** Env vars a helper or trial agent must never inherit from the observer. */
const SECRET_ENV = [/^PRIME_OBSERVER_/, /^RUNPOD_/, /^DEPLOY_GIT_SSH_KEY$/, /^VLLM_API_KEY$/, /^PUBLIC_KEY$/];

export function helperEnv(base: NodeJS.ProcessEnv, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(base)) {
		if (v !== undefined && !SECRET_ENV.some((re) => re.test(k))) env[k] = v;
	}
	for (const [k, v] of Object.entries(extra)) {
		if (v === undefined) delete env[k];
		else env[k] = v;
	}
	return env;
}

/**
 * Unix socket paths are capped at 104 bytes on macOS (108 on Linux); data-dir-relative paths blow
 * past that (`listen EINVAL`). Per-run daemons therefore get short sockets in a fixed directory.
 */
export function benchSocketPath(tag: string): string {
	const dir = process.env.PRIME_BENCH_SOCKET_DIR ?? "/tmp/prime-bench";
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const safe = tag.replace(/[^A-Za-z0-9_-]/g, "").slice(-40) || "run";
	return join(dir, `${safe}.sock`);
}

/**
 * Spawn a helper process in its own process group, stream stdout to a file (trial transcripts
 * can be large), keep a stderr tail for errors, and kill the whole group on timeout or cancel.
 */
export function runProcess(options: {
	bin: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdoutPath: string;
	stdin?: string;
	timeoutMs: number;
	onStdoutLine?: (line: string) => void;
}): ProcHandle {
	mkdirSync(dirname(options.stdoutPath), { recursive: true });
	const out = createWriteStream(options.stdoutPath);
	const child = spawn(options.bin, options.args, {
		cwd: options.cwd,
		env: options.env,
		detached: true,
		stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	let stderrTail = "";
	let timedOut = false;
	let cancelled = false;
	let partial = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out.write(chunk);
		if (!options.onStdoutLine) return;
		partial += chunk.toString("utf8");
		let nl = partial.indexOf("\n");
		while (nl >= 0) {
			options.onStdoutLine(partial.slice(0, nl));
			partial = partial.slice(nl + 1);
			nl = partial.indexOf("\n");
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
	});
	if (options.stdin !== undefined && child.stdin) {
		child.stdin.on("error", () => undefined);
		child.stdin.end(options.stdin);
	}
	const killGroup = (signal: NodeJS.Signals) => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			// already gone
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup("SIGTERM");
		setTimeout(() => killGroup("SIGKILL"), 5000).unref();
	}, options.timeoutMs);
	const done = new Promise<ProcResult>((resolve) => {
		child.on("error", (e) => {
			stderrTail += `\n${e.message}`;
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (partial && options.onStdoutLine) options.onStdoutLine(partial);
			out.end(() => resolve({ code, signal, timedOut, cancelled, stderrTail }));
		});
	});
	return {
		pid: child.pid,
		done,
		cancel: () => {
			cancelled = true;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 5000).unref();
		},
	};
}

/**
 * Stop exactly one daemon. `prime-agent shutdown --force` is NOT usable here: it ignores socket
 * selection and stops every background service on the machine, including the user's own daemon.
 */
export async function shutdownDaemonAt(socketPath: string): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(2000);
		await client.waitForHello(3000);
		const res = await client.request({ type: "shutdown", force: true } as never, 20000);
		return !!res.success;
	} catch (e) {
		log.debug(`daemon at ${socketPath} not stopped: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	} finally {
		client.close();
	}
}
