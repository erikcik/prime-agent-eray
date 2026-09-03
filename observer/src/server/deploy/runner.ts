import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DeployRun } from "../../shared/api.ts";
import { logger } from "../log.ts";

export const RESTART_EXIT_CODE = 87;

export interface DeployRunnerOptions {
	hookPath: string;
	repoRoot: string;
	dataDir: string;
	port: number;
	agentDir: string;
	onLine: (runId: string, line: string, stream: "out" | "err") => void;
	onStarted: (runId: string) => void;
	onDone: (runId: string, exitCode: number, willRestart: boolean) => void;
	/** Called after a successful run; the server should shut down and exit 87. */
	requestRestart: () => void;
}

/**
 * Runs the deploy hook (deploy/refresh.sh by default), streams its output, persists a log so the
 * post-restart UI can show it, and asks the server to exit with code 87 on success.
 */
export class DeployRunner {
	private current: DeployRun | undefined;
	private log = logger("deploy");

	constructor(private readonly opts: DeployRunnerOptions) {
		mkdirSync(join(opts.dataDir, "deploy"), { recursive: true });
	}

	get running(): DeployRun | undefined {
		return this.current?.running ? this.current : undefined;
	}

	start(): DeployRun {
		if (this.current?.running) throw Object.assign(new Error("a deploy is already running"), { status: 409, code: "deploy_running" });
		if (!existsSync(this.opts.hookPath)) {
			throw Object.assign(new Error(`deploy hook not found: ${this.opts.hookPath}`), { status: 500, code: "hook_missing" });
		}
		const runId = new Date().toISOString().replace(/[:.]/g, "-");
		const run: DeployRun = { runId, startedAt: new Date().toISOString(), lines: [], running: true };
		this.current = run;
		const logPath = join(this.opts.dataDir, "deploy", `${runId}.log`);
		const env = { ...process.env };
		delete env.PRIME_OBSERVER_TOKEN;
		delete env.NANO_GPT_API_KEY;
		delete env.ANTHROPIC_OAUTH_TOKEN;
		delete env.ANTHROPIC_API_KEY;
		delete env.RUNPOD_API_KEY;
		Object.assign(env, {
			OBSERVER_REPO_ROOT: this.opts.repoRoot,
			OBSERVER_PORT: String(this.opts.port),
			OBSERVER_RUN_ID: runId,
			OBSERVER_PID: String(process.pid),
			PRIME_AGENT_CODING_AGENT_DIR: this.opts.agentDir,
		});
		this.log.info(`starting deploy ${runId} via ${this.opts.hookPath}`);
		this.opts.onStarted(runId);
		const child = spawn("bash", [this.opts.hookPath], { cwd: this.opts.repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
		const push = (stream: "out" | "err") => (buf: Buffer) => {
			for (const raw of buf.toString("utf8").split("\n")) {
				if (!raw.trim()) continue;
				const line = `[${stream}] ${raw}`;
				run.lines.push(line);
				if (run.lines.length > 5000) run.lines.splice(0, run.lines.length - 5000);
				void appendFile(logPath, `${line}\n`).catch(() => undefined);
				this.opts.onLine(runId, raw, stream);
			}
		};
		child.stdout.on("data", push("out"));
		child.stderr.on("data", push("err"));
		child.on("error", (e) => {
			push("err")(Buffer.from(`spawn failed: ${e.message}`));
			finish(126);
		});
		child.on("exit", (code) => finish(code ?? 1));
		const finish = (code: number) => {
			if (!run.running) return;
			run.running = false;
			run.exitCode = code;
			run.finishedAt = new Date().toISOString();
			const willRestart = code === 0;
			void appendFile(logPath, `[done] exit=${code} willRestart=${willRestart}\n`).catch(() => undefined);
			this.opts.onDone(runId, code, willRestart);
			this.log.info(`deploy ${runId} finished exit=${code}`);
			if (willRestart) setTimeout(() => this.opts.requestRestart(), 300);
		};
		return run;
	}

	async last(): Promise<DeployRun | undefined> {
		if (this.current) return this.current;
		const dir = join(this.opts.dataDir, "deploy");
		let files: string[];
		try {
			files = (await readdir(dir)).filter((f) => f.endsWith(".log")).sort();
		} catch {
			return undefined;
		}
		const latest = files.at(-1);
		if (!latest) return undefined;
		const text = await readFile(join(dir, latest), "utf8");
		const lines = text.split("\n").filter(Boolean);
		const done = lines.find((l) => l.startsWith("[done]"));
		const exit = done ? Number(/exit=(\d+)/.exec(done)?.[1] ?? "1") : undefined;
		return {
			runId: latest.replace(/\.log$/, ""),
			startedAt: latest.replace(/\.log$/, ""),
			finishedAt: done ? undefined : undefined,
			exitCode: exit,
			lines: lines.filter((l) => !l.startsWith("[done]")),
			running: false,
		};
	}
}
