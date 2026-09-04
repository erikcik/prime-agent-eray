import type {
	CommsResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	DeployRun,
	HealthResponse,
	MessagesPage,
	ModelsResponse,
	SchedulesResponse,
	SessionDetail,
} from "../../shared/api.ts";
import type { AgentNode, FleetTree } from "../../shared/fleet.ts";
import type { HarnessView, RefinementResult, SkillDoc, SkillSummary } from "../../shared/harness.ts";
import { clearToken, getToken } from "./auth.ts";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
		readonly body?: Record<string, unknown>,
	) {
		super(message);
	}
}

let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(fn: () => void): void {
	onUnauthorized = fn;
}

/** A file attached from the composer, stored in the session's `inbox/`. */
export interface UploadedFile {
	name: string;
	/** cwd-relative, e.g. `inbox/brief.pdf` — what the prompt announces to the agent. */
	path: string;
	absolute: string;
	bytes: number;
	modified_at: string;
}

/**
 * Upload one asset as a RAW body with the name in a header — never multipart, and never
 * through call(), which would JSON-stringify a File into "{}". The server streams this
 * straight to disk (see server/http/uploads.ts). No client-side timeout: a large file on a
 * slow uplink must be allowed to take as long as it takes, and the server bounds size, not time.
 */
export async function uploadFile(file: File, session?: string, signal?: AbortSignal): Promise<UploadedFile> {
	const token = getToken();
	const headers: Record<string, string> = {
		"content-type": "application/octet-stream",
		// encodeURIComponent so non-ASCII names survive a header that must be latin-1.
		"x-file-name": encodeURIComponent(file.name),
	};
	if (token) headers.authorization = `Bearer ${token}`;
	const query = session ? `?session=${encodeURIComponent(session)}` : "";
	const res = await fetch(`/api/uploads${query}`, { method: "POST", headers, body: file, signal });
	if (res.status === 401) {
		clearToken();
		onUnauthorized?.();
		throw new ApiError(401, "unauthorized", "unauthorized");
	}
	const text = await res.text();
	let parsed: Record<string, unknown> = {};
	if (text) {
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			parsed = { error: text };
		}
	}
	if (!res.ok) throw new ApiError(res.status, String(parsed.error ?? res.statusText), typeof parsed.code === "string" ? parsed.code : undefined, parsed);
	return parsed.file as UploadedFile;
}

async function call<T>(method: string, path: string, body?: unknown, tokenOverride?: string): Promise<T> {
	const token = tokenOverride ?? getToken();
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	if (res.status === 401) {
		if (!tokenOverride) {
			clearToken();
			onUnauthorized?.();
		}
		throw new ApiError(401, "unauthorized", "unauthorized");
	}
	const text = await res.text();
	let parsed: unknown = undefined;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { error: text };
		}
	}
	if (!res.ok) {
		const b = (parsed ?? {}) as Record<string, unknown>;
		throw new ApiError(res.status, String(b.error ?? res.statusText), typeof b.code === "string" ? b.code : undefined, b);
	}
	return parsed as T;
}

export const api = {
	health: (token?: string) => call<HealthResponse>("GET", "/api/health", undefined, token),
	fleet: (token?: string) => call<FleetTree>("GET", "/api/fleet", undefined, token),
	sessions: (scope: "all" | "live" | "saved" = "all") => call<AgentNode[]>("GET", `/api/sessions?scope=${scope}`),
	createSession: (req: CreateSessionRequest) => call<CreateSessionResponse>("POST", "/api/sessions", req),
	resumeSession: (id: string, cwd?: string) => call<CreateSessionResponse>("POST", `/api/sessions/${enc(id)}/resume`, { cwd }),
	models: (activeSessionId?: string) => call<ModelsResponse>("GET", `/api/models${activeSessionId ? `?activeSessionId=${enc(activeSessionId)}` : ""}`),
	session: (id: string) => call<SessionDetail>("GET", `/api/sessions/${enc(id)}`),
	messages: (id: string, opts: { before?: number; limit?: number } = {}) => {
		const q = new URLSearchParams();
		if (opts.before !== undefined) q.set("before", String(opts.before));
		if (opts.limit !== undefined) q.set("limit", String(opts.limit));
		return call<MessagesPage>("GET", `/api/sessions/${enc(id)}/messages?${q}`);
	},
	stats: (id: string) => call<{ live: boolean; stats: unknown }>("GET", `/api/sessions/${enc(id)}/stats`),
	contextTree: (id: string) => call<unknown>("GET", `/api/sessions/${enc(id)}/context-tree`),
	children: (id: string) => call<{ live: boolean; children: unknown[]; nodes?: AgentNode[] }>("GET", `/api/sessions/${enc(id)}/children`),
	sessionHarness: (id: string) => call<HarnessView>("GET", `/api/sessions/${enc(id)}/harness`),
	sessionSchedules: (id: string) => call<{ jobs: unknown[] }>("GET", `/api/sessions/${enc(id)}/schedules`),
	prompt: (id: string, message: string, behavior?: "steer" | "followUp") => call("POST", `/api/sessions/${enc(id)}/prompt`, { message, behavior }),
	steer: (id: string, message: string) => call("POST", `/api/sessions/${enc(id)}/steer`, { message }),
	followUp: (id: string, message: string) => call("POST", `/api/sessions/${enc(id)}/follow-up`, { message }),
	abort: (id: string) => call("POST", `/api/sessions/${enc(id)}/abort`),
	kill: (id: string) => call("POST", `/api/sessions/${enc(id)}/kill`),
	sendAgentMessage: (id: string, message: string, fromActiveSessionId?: string) => call<{ ok: true; from: string }>("POST", `/api/sessions/${enc(id)}/message`, { message, fromActiveSessionId }),
	exportHtml: (id: string) => call<{ downloadPath: string; path: string }>("POST", `/api/sessions/${enc(id)}/export.html`),
	harness: (session?: string) => call<HarnessView>("GET", `/api/harness${session ? `?session=${enc(session)}` : ""}`),
	harnessHistory: (session?: string) => call<RefinementResult[]>("GET", `/api/harness/history${session ? `?session=${enc(session)}` : ""}`),
	rollback: (refinementId: string, activeSessionId?: string) => call<{ ok: true; result: unknown }>("POST", "/api/harness/rollback", { refinementId, activeSessionId }),
	refine: (activeSessionId: string, instructions?: string, global?: boolean) => call("POST", "/api/harness/refine", { activeSessionId, instructions, global }),
	skills: (cwd?: string) => call<{ skills: SkillSummary[]; diagnostics: unknown[] }>("GET", `/api/skills${cwd ? `?cwd=${enc(cwd)}` : ""}`),
	skillDoc: (name: string, cwd?: string) => call<SkillDoc>("GET", `/api/skills/${enc(name)}/doc${cwd ? `?cwd=${enc(cwd)}` : ""}`),
	schedules: () => call<SchedulesResponse>("GET", "/api/schedules"),
	comms: (session?: string, limit = 300) => call<CommsResponse>("GET", `/api/comms?limit=${limit}${session ? `&session=${enc(session)}` : ""}`),
	daemonStart: () => call<{ exitCode: number; connected: boolean; lines: string[] }>("POST", "/api/daemon/start"),
	daemonRestart: () => call("POST", "/api/daemon/restart"),
	daemonShutdown: (force = false) => call("POST", "/api/daemon/shutdown", { force }),
	daemonLog: (lines = 200) => call<{ path: string; lines: string[] }>("GET", `/api/daemon/log?lines=${lines}`),
	deploy: () => call<{ runId: string }>("POST", "/api/deploy"),
	deployLast: () => call<DeployRun | null>("GET", "/api/deploy/last"),
	uploads: (session?: string) => call<{ cwd: string; inbox: string; files: UploadedFile[] }>("GET", `/api/uploads${session ? `?session=${enc(session)}` : ""}`),
	// Raw-body upload; deliberately not routed through call(). See uploadFile above.
	uploadFile,
};

function enc(s: string): string {
	return encodeURIComponent(s);
}

/** Authenticated download: fetch as blob and open in a new tab (links can't carry the bearer). */
export async function openAuthenticated(path: string): Promise<void> {
	const token = getToken();
	const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
	if (!res.ok) throw new ApiError(res.status, res.statusText);
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	window.open(url, "_blank", "noopener");
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
