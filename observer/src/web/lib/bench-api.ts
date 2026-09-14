import type {
	AdvisorEvent,
	BenchJob,
	BenchOverview,
	BenchRun,
	BenchSettings,
	BenchTask,
	CaptureRequest,
	Experiment,
	RunSummary,
	TimelineEntry,
	Variant,
	VerifiedSkill,
} from "../../shared/bench.ts";
import { call } from "./api.ts";

export interface CreateExperimentInput {
	title: string;
	description: string;
	taskIds?: string[];
	variantCount?: number;
	models?: { primeAgent?: string; claudeCode?: string };
	includeClaudeCode?: boolean;
	repeats?: number;
	concurrency?: number;
	schedule?: { everyDays: number } | null;
}

export interface LiveSessionRef {
	sessionId: string;
	sessionFile: string;
	activeSessionId: string;
	isStreaming: boolean;
}

const e = encodeURIComponent;

export const benchApi = {
	overview: () => call<BenchOverview>("GET", "/api/bench"),
	saveSettings: (patch: Partial<BenchSettings>) => call<BenchSettings>("POST", "/api/bench/settings", patch),
	timeline: (sessionId: string) => call<{ sessionFile: string; rows: TimelineEntry[] }>("GET", `/api/bench/sessions/${e(sessionId)}/timeline`),
	imagePath: (sessionId: string, entryId: string, index: number) => `/api/bench/sessions/${e(sessionId)}/entries/${e(entryId)}/images/${index}`,

	capture: (req: CaptureRequest) => call<BenchJob>("POST", "/api/bench/tasks/capture", req),
	task: (id: string) => call<{ task: BenchTask; timeline: TimelineEntry[] }>("GET", `/api/bench/tasks/${e(id)}`),
	updateTask: (id: string, patch: Partial<BenchTask>) => call<BenchTask>("POST", `/api/bench/tasks/${e(id)}`, patch),
	deleteTask: (id: string) => call<{ ok: true }>("DELETE", `/api/bench/tasks/${e(id)}`),

	mine: (sessionId: string) => call<BenchJob>("POST", "/api/bench/candidates/mine", { sessionId }),
	accept: (id: string, body: { desiredTrajectory?: string; title?: string }) => call<BenchJob>("POST", `/api/bench/candidates/${e(id)}/accept`, body),
	reject: (id: string) => call<{ ok: true }>("POST", `/api/bench/candidates/${e(id)}/reject`),

	createExperiment: (input: CreateExperimentInput) => call<{ experiment: Experiment; job?: BenchJob }>("POST", "/api/bench/experiments", input),
	experiment: (id: string) => call<{ experiment: Experiment; runs: RunSummary[]; active: boolean }>("GET", `/api/bench/experiments/${e(id)}`),
	updateExperiment: (id: string, patch: Partial<Experiment>) => call<Experiment>("POST", `/api/bench/experiments/${e(id)}`, patch),
	deleteExperiment: (id: string) => call<{ ok: true }>("DELETE", `/api/bench/experiments/${e(id)}`),
	generateVariants: (id: string, count: number) => call<BenchJob>("POST", `/api/bench/experiments/${e(id)}/variants/generate`, { count }),
	promote: (id: string, variantId: string) => call<Variant>("POST", `/api/bench/experiments/${e(id)}/variants/${e(variantId)}/promote`),
	run: (id: string, only: { taskIds?: string[]; armIds?: string[]; repeats?: number } = {}) => call<BenchRun>("POST", `/api/bench/experiments/${e(id)}/run`, only),

	runDetail: (id: string) => call<{ run: BenchRun; summary: RunSummary; active: boolean }>("GET", `/api/bench/runs/${e(id)}`),
	cancelRun: (id: string) => call<{ ok: true }>("POST", `/api/bench/runs/${e(id)}/cancel`),
	trialRows: (runId: string, trialId: string) => call<{ rows: TimelineEntry[] }>("GET", `/api/bench/runs/${e(runId)}/trials/${e(trialId)}/rows`),

	advisor: () => call<{ events: AdvisorEvent[]; verified: VerifiedSkill[]; live: LiveSessionRef[] }>("GET", "/api/bench/advisor"),
	advisorCheck: (sessionId: string) => call<{ event: AdvisorEvent | null }>("POST", "/api/bench/advisor/check", { sessionId }),
	advisorSend: (eventId: string) => call<AdvisorEvent>("POST", `/api/bench/advisor/events/${e(eventId)}/send`),
};
