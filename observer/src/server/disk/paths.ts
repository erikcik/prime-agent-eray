import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Mirrors packages/coding-agent/src/config.ts + session-manager.ts path conventions (read-only). */
export interface AgentPaths {
	agentDir: string;
	sessionsDir: string;
	artifactsRoot: string;
	ledgerDir: string;
	globalHarnessDir: string;
	skillsDir: string;
	logsDir: string;
	settingsFile: string;
	modelsFile: string;
	cronJobsFile: string;
}

export function agentPaths(agentDir: string, sessionsDirOverride?: string): AgentPaths {
	const sessionsDir = sessionsDirOverride ?? join(agentDir, "sessions");
	return {
		agentDir,
		sessionsDir,
		// session-manager.ts: getSessionArtifactsRoot(sessionDir) = join(dirname(sessionDir), "session-artifacts")
		artifactsRoot: join(dirname(sessionsDir), "session-artifacts"),
		ledgerDir: join(agentDir, "rlm-ledger"),
		globalHarnessDir: join(agentDir, "harness"),
		skillsDir: join(agentDir, "skills"),
		logsDir: join(agentDir, "logs"),
		settingsFile: join(agentDir, "settings.json"),
		modelsFile: join(agentDir, "models.json"),
		cronJobsFile: join(agentDir, "cron-jobs.json"),
	};
}

export function sessionIdFromFile(sessionFile: string): string {
	return basename(sessionFile).replace(/\.jsonl$/, "");
}

/**
 * session-manager.ts getSessionArtifactPathForFile(): join(dirname(dirname(file)), "session-artifacts", id).
 * Root `agent/sessions/X.jsonl` -> `agent/session-artifacts/X`; child `<parentArt>/sub-a/Y.jsonl` -> `<parentArt>/session-artifacts/Y`.
 */
export function artifactDirForSessionFile(sessionFile: string): string {
	return join(dirname(dirname(sessionFile)), "session-artifacts", sessionIdFromFile(sessionFile));
}

/** A child session file `<parentArtifactDir>/sub-<id>/<child>.jsonl` implies its parent's artifact dir. */
export function parentArtifactDirFromChildFile(childFile: string): string {
	return dirname(dirname(childFile));
}

export function localHarnessDir(artifactDir: string): string {
	return join(artifactDir, "harness");
}

/** config.ts getDaemonLogPath(socketPath): logs/<basename>.<sha256(socket)[0..8]>.log */
export function daemonLogPath(logsDir: string, socketPath: string): string {
	const hash = createHash("sha256").update(socketPath).digest("hex").slice(0, 8);
	return join(logsDir, `${basename(socketPath)}.${hash}.log`);
}
