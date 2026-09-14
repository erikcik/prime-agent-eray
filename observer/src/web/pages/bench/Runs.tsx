import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { BenchRun, RunSummary, TimelineEntry, Trial } from "../../../shared/bench.ts";
import { ConfirmDialog, EmptyState, ErrorLine, Eyebrow, KV } from "../../components/common.tsx";
import { benchApi } from "../../lib/bench-api.ts";
import { dateTime, duration, shortId, timeAgo, tokens, usd } from "../../lib/format.ts";
import { pct, TimelineRows, trialPill, useBench } from "./Bench.tsx";

export function RunsTab() {
	const { data } = useBench();
	const [params, setParams] = useSearchParams();
	const runs = data?.runs ?? [];
	const selected = params.get("run") ?? runs[0]?.runId;
	const expFor = (r: RunSummary) => data?.experiments.find((x) => x.lastRunId === r.runId);

	return (
		<div className="bench-split">
			<div className="card bench-list">
				{runs.length === 0 && <EmptyState title="No runs yet">Run an experiment to see trials here.</EmptyState>}
				{runs.map((r) => {
					const total = r.arms.reduce((s, a) => s + a.trials, 0);
					const finished = r.arms.reduce((s, a) => s + a.finished, 0);
					const cost = r.arms.reduce((s, a) => s + a.costUsd, 0);
					return (
						<button key={r.runId} type="button" className={`bench-item${r.runId === selected ? " is-active" : ""}`} onClick={() => setParams({ run: r.runId })}>
							<div className="bench-item__title">{expFor(r)?.title ?? shortId(r.runId, 20)}</div>
							<div className="bench-item__meta">
								<span className={`pill ${r.status === "running" ? "pill--live" : r.status === "done" ? "pill--ink" : "pill--ghost"}`}>{r.status}</span>
								<span className="mono tiny muted">
									{finished}/{total} trials · {usd(cost)}
								</span>
								<span className="mono tiny muted">{timeAgo(r.createdAt)}</span>
							</div>
						</button>
					);
				})}
			</div>
			<div>{selected && <RunDetail key={selected} id={selected} />}</div>
		</div>
	);
}

function RunDetail({ id }: { id: string }) {
	const { data } = useBench();
	const [detail, setDetail] = useState<{ run: BenchRun; summary: RunSummary; active: boolean }>();
	const [error, setError] = useState<unknown>();
	const [open, setOpen] = useState<string>();
	const [confirmCancel, setConfirmCancel] = useState(false);
	const stamp = data?.runs.find((r) => r.runId === id);
	const stampKey = stamp ? `${stamp.status}:${stamp.arms.map((a) => a.finished).join(",")}` : "";

	const load = useCallback(async () => {
		try {
			setDetail(await benchApi.runDetail(id));
		} catch (e) {
			setError(e);
		}
	}, [id]);

	useEffect(() => {
		void load();
	}, [load, stampKey]);

	// Trial status changes (running -> judging) do not change the summary; poll while active.
	useEffect(() => {
		if (!detail?.active) return;
		const t = setInterval(() => void load(), 5000);
		return () => clearInterval(t);
	}, [detail?.active, load]);

	if (!detail) return <ErrorLine error={error} />;
	const { run, summary } = detail;
	const title = (taskId: string) => data?.tasks.find((t) => t.id === taskId)?.title ?? shortId(taskId, 14);
	const arm = (armId: string) => run.arms.find((a) => a.id === armId);

	return (
		<div className="col" style={{ gap: 14 }}>
			<ErrorLine error={error} />
			<section className="card">
				<header className="card__head">
					<div className="row grow">
						<Eyebrow ink>run</Eyebrow>
						<span className="mono tiny">{run.id}</span>
						<span className={`pill ${run.status === "running" ? "pill--live" : "pill--ghost"}`}>{run.status}</span>
					</div>
					{detail.active && (
						<button type="button" className="btn btn--danger btn--small" onClick={() => setConfirmCancel(true)}>
							Cancel run
						</button>
					)}
				</header>
				<div className="card__body">
					<KV k="started" v={dateTime(run.createdAt)} mono />
					<KV k="trigger" v={run.trigger} mono />
					<KV k="repo commit" v={run.environment.repoCommit?.slice(0, 12)} mono />
					<KV k="harness" v={run.environment.harnessVersion} mono />
					<KV k="claude code" v={run.environment.claudeCodeVersion} mono />
					<KV k="memory stamp" v={run.environment.memoryStamp} mono />
					<div className="matrix" style={{ marginTop: 10 }}>
						<table className="table table--tight">
							<thead>
								<tr>
									<th>arm</th>
									<th>pass rate</th>
									<th>mean score</th>
									<th>finished</th>
									<th>cost</th>
								</tr>
							</thead>
							<tbody>
								{summary.arms.map((a) => (
									<tr key={a.armId}>
										<td className="small">{a.label}</td>
										<td className="mono small">{pct(a.passRate)}</td>
										<td className="mono small">{pct(a.meanScore)}</td>
										<td className="mono small">
											{a.finished}/{a.trials}
										</td>
										<td className="mono small">{usd(a.costUsd)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</section>
			<section className="card">
				<header className="card__head">
					<Eyebrow ink>trials · {run.trials.length}</Eyebrow>
				</header>
				<div className="card__body matrix">
					<table className="table table--tight">
						<thead>
							<tr>
								<th>checkpoint</th>
								<th>arm</th>
								<th>#</th>
								<th>status</th>
								<th>score</th>
								<th>time</th>
								<th>cost</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{run.trials.map((t) => (
								<TrialRow key={t.id} t={t} taskTitle={title(t.taskId)} armLabel={arm(t.armId)?.label ?? t.armId} open={open === t.id} onToggle={() => setOpen(open === t.id ? undefined : t.id)} />
							))}
						</tbody>
					</table>
				</div>
			</section>
			{confirmCancel && (
				<ConfirmDialog
					title="Cancel run"
					danger
					confirmLabel="Cancel run"
					body={<p>Running trials are killed; queued trials never start. Finished trials keep their verdicts.</p>}
					onCancel={() => setConfirmCancel(false)}
					onConfirm={async () => {
						setConfirmCancel(false);
						try {
							await benchApi.cancelRun(id);
							await load();
						} catch (e) {
							setError(e);
						}
					}}
				/>
			)}
		</div>
	);
}

function TrialRow({ t, taskTitle, armLabel, open, onToggle }: { t: Trial; taskTitle: string; armLabel: string; open: boolean; onToggle: () => void }) {
	return (
		<>
			<tr onClick={onToggle} style={{ cursor: "pointer" }}>
				<td className="small">{taskTitle}</td>
				<td className="small">{armLabel}</td>
				<td className="mono small">{t.repeat + 1}</td>
				<td>
					<span className={`pill ${trialPill(t.status)}`}>
						{(t.status === "running" || t.status === "judging" || t.status === "preparing") && <span className="dot dot--running" />}
						{t.status}
					</span>
					{t.warnings.length > 0 && <span className="tiny accent-text"> · {t.warnings.length} warning(s)</span>}
				</td>
				<td className="mono small">{t.verdict ? pct(t.verdict.score) : "—"}</td>
				<td className="mono small">{t.durationMs ? duration(t.durationMs) : t.startedAt && !t.endedAt ? timeAgo(t.startedAt) : "—"}</td>
				<td className="mono small">{usd((t.costUsd ?? 0) + (t.verdict?.costUsd ?? 0))}</td>
				<td className="tiny muted">{open ? "hide" : "open"}</td>
			</tr>
			{open && (
				<tr>
					<td colSpan={8}>
						<TrialDetail t={t} />
					</td>
				</tr>
			)}
		</>
	);
}

function TrialDetail({ t }: { t: Trial }) {
	const [rows, setRows] = useState<TimelineEntry[]>();
	const [error, setError] = useState<unknown>();
	const finished = t.status === "passed" || t.status === "failed" || t.status === "error" || t.status === "judging";

	useEffect(() => {
		if (!finished) return;
		benchApi
			.trialRows(t.runId, t.id)
			.then((r) => setRows(r.rows))
			.catch(setError);
	}, [t.runId, t.id, finished]);

	return (
		<div className="col" style={{ gap: 10, padding: "6px 0" }}>
			<ErrorLine error={error} />
			{t.error && <pre className="codeblock codeblock--err">{t.error}</pre>}
			{t.warnings.map((w) => (
				<div key={w} className="banner">
					{w}
				</div>
			))}
			{t.verdict && (
				<div className="col" style={{ gap: 6 }}>
					<div className="small">
						<span className="eyebrow">judge ({t.verdict.judgeModel})</span> {t.verdict.summary}
					</div>
					{t.verdict.criteria.map((c) => (
						<div key={c.id} className="row small" style={{ alignItems: "flex-start" }}>
							<span className={`pill ${c.met ? "pill--ink" : "pill--fail"}`}>
								{c.id} {c.met ? "met" : "not met"}
							</span>
							<span className="soft">{c.evidence}</span>
						</div>
					))}
				</div>
			)}
			<div className="row tiny muted wrap">
				{t.tokens && (
					<span className="mono">
						tokens in {tokens(t.tokens.input)} · out {tokens(t.tokens.output)} · cache read {tokens(t.tokens.cacheRead)}
					</span>
				)}
				{t.exitCode !== undefined && <span className="mono">exit {String(t.exitCode)}</span>}
				{t.workspaceDir && <span className="mono">workspace {t.workspaceDir}</span>}
			</div>
			{finished ? (
				<details>
					<summary className="eyebrow" style={{ cursor: "pointer" }}>
						transcript after the checkpoint ({rows?.length ?? "…"} rows)
					</summary>
					<div style={{ marginTop: 8 }}>{rows && <TimelineRows rows={rows} empty="The agent produced nothing." />}</div>
				</details>
			) : (
				<span className="tiny muted">The transcript appears when the trial finishes.</span>
			)}
		</div>
	);
}
