import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { logger } from "../log.ts";

const log = logger("recorder");

/** Never snapshot these; they are rebuildable or belong to the tooling itself. */
const DEFAULT_EXCLUDES = [
	".git/",
	"node_modules/",
	".venv/",
	"venv/",
	"__pycache__/",
	".next/",
	".turbo/",
	".cache/",
	".DS_Store",
	".prime/agent/kernel-venv/",
	"*.sock",
];

export interface RecordedCommit {
	commit: string;
	at: string;
}

/**
 * Shadow-git workspace recorder. Each session cwd gets a private git dir under the bench data
 * directory whose work tree is the cwd itself, so recording never touches the project's own
 * `.git`. Commits dedupe unchanged files, which makes "record on every user message" cheap, and a
 * checkpoint later restores the files as they were at (or just before) that moment.
 */
export class WorkspaceRecorder {
	private chains = new Map<string, Promise<unknown>>();

	constructor(
		private readonly rootDir: string,
		private readonly opts: { skipUnder?: string[]; gitBin?: string } = {},
	) {
		mkdirSync(rootDir, { recursive: true });
	}

	repoFor(cwd: string): string {
		return join(this.rootDir, `${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 16)}.git`);
	}

	/** Recording $HOME, `/`, or our own trial workspaces would be wrong or enormous. */
	recordable(cwd: string | undefined): cwd is string {
		if (!cwd) return false;
		const abs = resolve(cwd);
		if (abs === "/" || abs === resolve(homedir())) return false;
		for (const root of [this.rootDir, ...(this.opts.skipUnder ?? [])]) {
			const r = resolve(root);
			if (abs === r || abs.startsWith(r + sep)) return false;
		}
		try {
			return statSync(abs).isDirectory();
		} catch {
			return false;
		}
	}

	/** Serialized per cwd so concurrent triggers never race on the index. */
	record(cwd: string, reason: string): Promise<RecordedCommit | undefined> {
		const key = resolve(cwd);
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(() => this.recordNow(key, reason));
		this.chains.set(key, next);
		return next;
	}

	private async recordNow(cwd: string, reason: string): Promise<RecordedCommit | undefined> {
		if (!this.recordable(cwd)) return undefined;
		const gitDir = this.repoFor(cwd);
		const at = new Date().toISOString();
		try {
			if (!existsSync(join(gitDir, "HEAD"))) {
				await this.git(gitDir, cwd, ["init", "-q"]);
				mkdirSync(join(gitDir, "info"), { recursive: true });
				writeFileSync(join(gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`);
				writeFileSync(join(gitDir, "description"), `prime observer workspace recorder for ${cwd}\n`);
			}
			await this.git(gitDir, cwd, ["add", "-A", "--ignore-errors", "."]);
			const head = await this.head(gitDir, cwd);
			const staged = head ? await this.git(gitDir, cwd, ["diff", "--cached", "--quiet"]).then(() => false, () => true) : true;
			if (!staged && head) return { commit: head, at };
			await this.git(gitDir, cwd, ["commit", "-q", "--allow-empty", "--no-verify", "-m", `${reason}\n\nrecorded-at: ${at}`], {
				GIT_COMMITTER_DATE: at,
				GIT_AUTHOR_DATE: at,
			});
			const commit = await this.head(gitDir, cwd);
			return commit ? { commit, at } : undefined;
		} catch (e) {
			log.warn(`recording ${cwd} failed`, e);
			return undefined;
		}
	}

	/** Latest commit recorded at or before `iso`. */
	async nearest(cwd: string, iso: string): Promise<RecordedCommit | undefined> {
		const gitDir = this.repoFor(cwd);
		if (!existsSync(join(gitDir, "HEAD"))) return undefined;
		try {
			const out = await this.git(gitDir, cwd, ["log", "-1", `--before=${iso}`, "--format=%H %cI"]);
			const [commit, at] = out.trim().split(" ");
			return commit ? { commit, at: new Date(at ?? iso).toISOString() } : undefined;
		} catch {
			return undefined;
		}
	}

	async fileCount(cwd: string, commit: string): Promise<number> {
		const out = await this.git(this.repoFor(cwd), cwd, ["ls-tree", "-r", "--name-only", commit]);
		return out.split("\n").filter(Boolean).length;
	}

	/** Extract a recorded tree into `dest` (which must exist). */
	materialize(cwd: string, commit: string, dest: string): Promise<void> {
		const gitDir = this.repoFor(cwd);
		return new Promise((resolvePromise, reject) => {
			const archive = spawn(this.opts.gitBin ?? "git", ["--git-dir", gitDir, "archive", "--format=tar", commit], { stdio: ["ignore", "pipe", "pipe"] });
			const tar = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
			let err = "";
			archive.stderr.on("data", (d) => (err += String(d)));
			tar.stderr.on("data", (d) => (err += String(d)));
			archive.stdout.pipe(tar.stdin);
			let archiveCode: number | null = null;
			archive.on("close", (code) => {
				archiveCode = code;
			});
			tar.on("close", (code) => {
				if (code === 0 && archiveCode === 0) resolvePromise();
				else reject(new Error(`materialize ${commit} failed: ${err.trim() || `git ${archiveCode}, tar ${code}`}`));
			});
		});
	}

	private async head(gitDir: string, cwd: string): Promise<string | undefined> {
		try {
			return (await this.git(gitDir, cwd, ["rev-parse", "--verify", "-q", "HEAD"])).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private git(gitDir: string, workTree: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			execFile(
				this.opts.gitBin ?? "git",
				["--git-dir", gitDir, "--work-tree", workTree, "-c", "user.name=prime-bench", "-c", "user.email=bench@observer.local", "-c", "core.autocrlf=false", "-c", "gc.auto=0", ...args],
				{ cwd: workTree, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv } },
				(error, stdout, stderr) => {
					if (error) reject(Object.assign(error, { stderr }));
					else resolvePromise(stdout);
				},
			);
		});
	}
}
