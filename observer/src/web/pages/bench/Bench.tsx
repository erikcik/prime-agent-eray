import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { BenchOverview, TimelineEntry, TrialStatus } from "../../../shared/bench.ts";
import { Eyebrow, ErrorLine } from "../../components/common.tsx";
import { benchApi } from "../../lib/bench-api.ts";
import { timeAgo } from "../../lib/format.ts";
import { socket } from "../../lib/ws.ts";
import { AdvisorTab, SettingsTab } from "./Advisor.tsx";
import { CandidatesTab } from "./Candidates.tsx";
import { ExperimentsTab } from "./Experiments.tsx";
import { RunsTab } from "./Runs.tsx";
import { TasksTab } from "./Tasks.tsx";

interface BenchCtx {
	data: BenchOverview | undefined;
	reload: () => Promise<void>;
}

const Ctx = createContext<BenchCtx>({ data: undefined, reload: async () => undefined });

export function useBench(): BenchCtx {
	return useContext(Ctx);
}

export function BenchPage() {
	const [data, setData] = useState<BenchOverview>();
	const [error, setError] = useState<unknown>();
	const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const reload = useCallback(async () => {
		try {
			setData(await benchApi.overview());
			setError(undefined);
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void reload();
		const off = socket.subscribe("bench", () => {
			if (pending.current) return;
			pending.current = setTimeout(() => {
				pending.current = undefined;
				void reload();
			}, 300);
		});
		return () => {
			off();
			if (pending.current) clearTimeout(pending.current);
		};
	}, [reload]);

	const pendingCandidates = data?.candidates.filter((c) => c.status === "pending").length ?? 0;
	const runningRuns = data?.runs.filter((r) => r.status === "running").length ?? 0;
	const tabs: Array<[string, string, number | undefined]> = [
		["/bench", "tasks", data?.tasks.length],
		["/bench/candidates", "candidates", pendingCandidates || undefined],
		["/bench/experiments", "experiments", data?.experiments.length],
		["/bench/runs", "runs", runningRuns || undefined],
		["/bench/advisor", "advisor", undefined],
		["/bench/settings", "settings", undefined],
	];

	return (
		<Ctx.Provider value={{ data, reload }}>
			<div className="page-head">
				<div>
					<Eyebrow>checkpoint benchmarks</Eyebrow>
					<h1>Benchmarks from your own trajectories</h1>
					<p>Freeze the moments that matter, write down what "right" looks like, test harness changes against them every week, and plug what wins back into live sessions.</p>
				</div>
			</div>
			<ErrorLine error={error} />
			<Jobs data={data} />
			<div className="rail__tabs" style={{ marginBottom: 16 }}>
				{tabs.map(([to, label, n]) => (
					<NavLink key={to} to={to} end={to === "/bench"} className={({ isActive }) => `rail__tab${isActive ? " is-active" : ""}`}>
						{label}
						{n !== undefined && <span className="muted"> · {n}</span>}
					</NavLink>
				))}
			</div>
			<Routes>
				<Route index element={<TasksTab />} />
				<Route path="candidates" element={<CandidatesTab />} />
				<Route path="experiments" element={<ExperimentsTab />} />
				<Route path="runs" element={<RunsTab />} />
				<Route path="advisor" element={<AdvisorTab />} />
				<Route path="settings" element={<SettingsTab />} />
			</Routes>
		</Ctx.Provider>
	);
}

function Jobs({ data }: { data: BenchOverview | undefined }) {
	const [dismissed, setDismissed] = useState<Set<string>>(new Set());
	if (!data) return null;
	const visible = data.jobs.filter((j) => j.status === "running" || (!dismissed.has(j.id) && Date.now() - Date.parse(j.endedAt ?? j.startedAt) < 10 * 60_000)).slice(0, 6);
	if (visible.length === 0) return null;
	return (
		<div className="jobs">
			{visible.map((j) => (
				<div key={j.id} className={`job ${j.status === "error" ? "job--error" : ""}`}>
					<span className={`pill ${j.status === "running" ? "pill--live" : j.status === "error" ? "pill--fail" : "pill--ink"}`}>
						{j.status === "running" && <span className="dot dot--running" />}
						{j.kind}
					</span>
					<span className="grow truncate">{j.label}</span>
					{j.error && <span className="small job__error" title={j.error}>{j.error.slice(0, 160)}</span>}
					<span className="mono tiny muted">{timeAgo(j.endedAt ?? j.startedAt)}</span>
					{j.status !== "running" && (
						<button type="button" className="btn btn--ghost btn--small" onClick={() => setDismissed((s) => new Set([...s, j.id]))}>
							dismiss
						</button>
					)}
				</div>
			))}
		</div>
	);
}

export function trialPill(status: TrialStatus | string): string {
	if (status === "passed") return "pill--ink";
	if (status === "failed" || status === "error") return "pill--fail";
	if (status === "running" || status === "judging" || status === "preparing") return "pill--live";
	return "pill--ghost";
}

export function pct(n: number | null | undefined): string {
	return n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`;
}

export function TimelineRows({ rows, pickable, selected, onPick, empty = "Nothing to show." }: { rows: TimelineEntry[]; pickable?: (r: TimelineEntry) => boolean; selected?: string; onPick?: (r: TimelineEntry) => void; empty?: string }) {
	if (rows.length === 0) return <div className="empty">{empty}</div>;
	return (
		<div className="timeline-rows">
			{rows.map((r) => {
				const canPick = !!onPick && (!pickable || pickable(r));
				return (
					<div
						key={r.id}
						className={`trow trow--${r.role}${canPick ? " anchor-pick" : ""}${selected === r.id ? " is-active" : ""}`}
						onClick={canPick ? () => onPick?.(r) : undefined}
						role={canPick ? "button" : undefined}
					>
						<div className="row">
							<span className="eyebrow eyebrow--ink">{r.role}</span>
							{r.toolName && <span className="eyebrow">{r.toolName}</span>}
							<span className="mono tiny muted">{r.id}</span>
							<span className="grow" />
							{r.imageCount > 0 && <span className="tiny muted">{r.imageCount} image(s)</span>}
							<span className="mono tiny muted" title={r.at}>
								{timeAgo(r.at)}
							</span>
						</div>
						{r.text && <pre>{r.text}</pre>}
					</div>
				);
			})}
		</div>
	);
}
