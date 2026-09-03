import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SchedulesResponse } from "../../shared/api.ts";
import { Eyebrow, EmptyState, ErrorLine, MonoId } from "../components/common.tsx";
import { api } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { socket } from "../lib/ws.ts";

type Job = Record<string, unknown>;

export function SchedulesPage() {
	const [data, setData] = useState<SchedulesResponse>();
	const [error, setError] = useState<unknown>();
	const load = useCallback(async () => {
		try {
			setData(await api.schedules());
			setError(undefined);
		} catch (e) {
			setError(e);
		}
	}, []);
	useEffect(() => {
		void load();
		const off = socket.subscribe("schedules", () => void load());
		const t = setInterval(() => void load(), 30_000);
		return () => {
			off();
			clearInterval(t);
		};
	}, [load]);

	const cron = (data?.cron ?? []) as Job[];
	const heartbeats = (data?.heartbeats ?? []) as Job[];
	const offline = data?.offline ?? [];

	return (
		<>
			<div className="page-head">
				<div>
					<Eyebrow>schedules</Eyebrow>
					<h1>Heartbeats and cron</h1>
					<p>What will re-enter a session on its own, and when.</p>
				</div>
			</div>
			<ErrorLine error={error} />
			<div className="col" style={{ gap: 16 }}>
				<section className="card">
					<header className="card__head">
						<Eyebrow ink>live (daemon)</Eyebrow>
						<span className="mono tiny muted">
							{cron.length} jobs · {heartbeats.length} heartbeats
						</span>
					</header>
					{cron.length + heartbeats.length === 0 ? <EmptyState title="Nothing scheduled">Use /heartbeat or prime-agent schedule inside a session.</EmptyState> : <JobTable jobs={[...heartbeats.map((h) => ({ ...h, _kind: "heartbeat" })), ...cron.map((c) => ({ ...c, _kind: "cron" }))]} />}
				</section>
				{offline.map((o) => (
					<section className="card" key={o.sessionId}>
						<header className="card__head">
							<Eyebrow ink>saved session</Eyebrow>
							<Link to={`/sessions/${encodeURIComponent(o.sessionId)}`} className="mono small">
								<MonoId id={o.sessionId} copy={false} />
							</Link>
						</header>
						<JobTable jobs={o.jobs as Job[]} />
					</section>
				))}
			</div>
		</>
	);
}

function JobTable({ jobs }: { jobs: Job[] }) {
	const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "—" : JSON.stringify(v));
	return (
		<div style={{ overflowX: "auto" }}>
			<table className="table table--tight">
				<thead>
					<tr>
						<th>kind</th>
						<th>label / prompt</th>
						<th>schedule</th>
						<th>status</th>
						<th>delivery</th>
						<th>next run</th>
						<th>last run</th>
						<th>runs</th>
						<th>session</th>
					</tr>
				</thead>
				<tbody>
					{jobs.map((j, i) => (
						<tr key={String(j.id ?? i)}>
							<td className="mono small">{s(j._kind ?? j.source)}</td>
							<td className="small">{s(j.label ?? j.prompt).slice(0, 120)}</td>
							<td className="mono small">{s(j.schedule)}</td>
							<td className="mono small">{s(j.status)}</td>
							<td className="mono small">{s(j.deliveryMode)}</td>
							<td className="mono small">{j.nextRunAt ? dateTime(String(j.nextRunAt)) : "—"}</td>
							<td className="mono small">{j.lastRunAt ? dateTime(String(j.lastRunAt)) : "—"}</td>
							<td className="mono small">{s(j.runCount)}</td>
							<td className="mono small">
								{typeof j.sessionId === "string" ? (
									<Link to={`/sessions/${encodeURIComponent(String(j.activeSessionId ?? j.sessionId))}`}>
										<MonoId id={j.sessionId} n={8} copy={false} />
									</Link>
								) : (
									"—"
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
