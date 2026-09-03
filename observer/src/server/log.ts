type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.PRIME_OBSERVER_LOG_LEVEL as Level | undefined) ?? "info"] ?? 20;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
	if (LEVELS[level] < threshold) return;
	const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${msg}`;
	const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
	if (extra !== undefined) {
		const detail = extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra);
		out.write(`${line} ${detail}\n`);
	} else {
		out.write(`${line}\n`);
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function logger(scope: string) {
	return {
		debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
		info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
		warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
		error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
	};
}

export type Logger = ReturnType<typeof logger>;
