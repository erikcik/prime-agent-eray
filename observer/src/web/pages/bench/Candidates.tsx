import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { BenchCandidate } from "../../../shared/bench.ts";
import { AuthImage } from "../../components/AuthImage.tsx";
import { EmptyState, ErrorLine, Eyebrow, MonoId } from "../../components/common.tsx";
import { benchApi } from "../../lib/bench-api.ts";
import { dateTime, shortId } from "../../lib/format.ts";
import { fleetStore } from "../../state/app-state.ts";
import { useStore } from "../../state/store.ts";
import { useBench } from "./Bench.tsx";

export function CandidatesTab() {
	const { data } = useBench();
	const fleet = useStore(fleetStore);
	const [sessionId, setSessionId] = useState("");
	const [status, setStatus] = useState<BenchCandidate["status"] | "all">("pending");
	const [error, setError] = useState<unknown>();
	const [lightbox, setLightbox] = useState<string>();

	const sessions = useMemo(() => (fleet?.roots ?? []).map((n) => ({ id: n.sessionId, label: `${n.name ?? n.firstMessage?.slice(0, 60) ?? shortId(n.sessionId)}${n.activeSessionId ? " · live" : ""}` })), [fleet]);
	const list = (data?.candidates ?? []).filter((c) => status === "all" || c.status === status);
	const groups = useMemo(() => {
		const m = new Map<string, BenchCandidate[]>();
		for (const c of list) m.set(c.sessionId, [...(m.get(c.sessionId) ?? []), c]);
		return [...m.entries()];
	}, [list]);
	const mining = data?.jobs.some((j) => j.kind === "mine" && j.status === "running");

	async function mine() {
		setError(undefined);
		try {
			await benchApi.mine(sessionId);
		} catch (e) {
			setError(e);
		}
	}

	return (
		<>
			<ErrorLine error={error} />
			<section className="card" style={{ marginBottom: 14 }}>
				<div className="card__body row wrap">
					<span className="small soft grow">
						A separate agent reads a finished trajectory and proposes the major decisions worth benchmarking. You decide which become tasks.
					</span>
					<select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ maxWidth: 360 }}>
						<option value="">choose a session…</option>
						{sessions.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<button type="button" className="btn btn--primary btn--small" disabled={!sessionId} onClick={() => void mine()}>
						{mining ? "Mining… (another?)" : "Mine checkpoints"}
					</button>
				</div>
			</section>
			<div className="seg" style={{ marginBottom: 12 }}>
				{(["pending", "accepted", "rejected", "all"] as const).map((s) => (
					<button key={s} type="button" className={status === s ? "is-active" : ""} onClick={() => setStatus(s)}>
						{s}
					</button>
				))}
			</div>
			{groups.length === 0 && <EmptyState title="No candidates">Mine a session to get proposed checkpoints.</EmptyState>}
			{groups.map(([sid, items]) => (
				<div key={sid} style={{ marginBottom: 18 }}>
					<div className="row" style={{ marginBottom: 8 }}>
						<Eyebrow ink>session</Eyebrow>
						<Link className="mono small" to={`/sessions/${sid}`}>
							{shortId(sid, 12)}
						</Link>
						<span className="tiny muted">{items.length} candidate(s)</span>
					</div>
					<div className="col" style={{ gap: 10 }}>
						{items.map((c) => (
							<CandidateCard key={c.id} c={c} onOpen={setLightbox} onError={setError} />
						))}
					</div>
				</div>
			))}
			{lightbox && (
				<div className="lightbox" onClick={() => setLightbox(undefined)} role="presentation">
					<img src={lightbox} alt="screenshot" />
				</div>
			)}
		</>
	);
}

function CandidateCard({ c, onOpen, onError }: { c: BenchCandidate; onOpen: (url: string) => void; onError: (e: unknown) => void }) {
	const [open, setOpen] = useState(false);
	const [desired, setDesired] = useState("");
	const [busy, setBusy] = useState(false);

	async function accept() {
		setBusy(true);
		try {
			await benchApi.accept(c.id, { desiredTrajectory: desired || undefined });
			setOpen(false);
		} catch (e) {
			onError(e);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="card">
			<header className="card__head">
				<div className="row grow">
					<span className="pill pill--ghost">{c.kind}</span>
					<strong className="small">{c.title}</strong>
				</div>
				<div className="row">
					<span className="mono tiny muted">{dateTime(c.anchorAt)}</span>
					<MonoId id={c.anchorEntryId} />
					{c.status === "accepted" && c.taskId && (
						<Link className="btn btn--small" to={`/bench?task=${c.taskId}`}>
							open task
						</Link>
					)}
					{c.status === "pending" && (
						<>
							<button type="button" className="btn btn--small" onClick={() => void benchApi.reject(c.id).catch(onError)}>
								Reject
							</button>
							<button type="button" className="btn btn--primary btn--small" onClick={() => setOpen((o) => !o)}>
								Make it a task
							</button>
						</>
					)}
					{c.status === "rejected" && (
						<button type="button" className="btn btn--small" onClick={() => void benchApi.reject(c.id).catch(onError)}>
							Restore
						</button>
					)}
					{c.status === "accepted" && !c.taskId && <span className="pill pill--live">capturing</span>}
				</div>
			</header>
			<div className="card__body col" style={{ gap: 8 }}>
				<p className="small" style={{ margin: 0 }}>
					{c.summary}
				</p>
				<div className="small">
					<span className="eyebrow">decision</span> {c.decision}
				</div>
				<div className="small">
					<span className="eyebrow">why it matters</span> {c.whyMajor}
				</div>
				{c.alternatives.length > 0 && (
					<div className="small">
						<span className="eyebrow">what an expert might do</span>
						<ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
							{c.alternatives.map((a) => (
								<li key={a}>{a}</li>
							))}
						</ul>
					</div>
				)}
				{c.images.length > 0 && (
					<div className="thumbs">
						{c.images.map((img) => (
							<AuthImage key={`${img.entryId}:${img.index}`} path={benchApi.imagePath(c.sessionId, img.entryId, img.index)} alt={`${c.title} screenshot`} onOpen={onOpen} />
						))}
					</div>
				)}
				{open && (
					<div className="bench-form" style={{ marginTop: 6 }}>
						<label className="field">
							<span>desired trajectory (optional): what should have happened</span>
							<textarea className="textarea" rows={3} value={desired} onChange={(e) => setDesired(e.target.value)} />
						</label>
						<div className="row" style={{ justifyContent: "flex-end" }}>
							<button type="button" className="btn btn--small" onClick={() => setOpen(false)}>
								Cancel
							</button>
							<button type="button" className="btn btn--primary btn--small" disabled={busy} onClick={() => void accept()}>
								Capture as task
							</button>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
