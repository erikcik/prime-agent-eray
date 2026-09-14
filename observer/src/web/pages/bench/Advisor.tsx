import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AdvisorEvent, BenchSettings, VerifiedSkill } from "../../../shared/bench.ts";
import { EmptyState, ErrorLine, Eyebrow } from "../../components/common.tsx";
import { benchApi, type LiveSessionRef } from "../../lib/bench-api.ts";
import { shortId, timeAgo } from "../../lib/format.ts";
import { pct, useBench } from "./Bench.tsx";

export function AdvisorTab() {
	const { data, reload } = useBench();
	const [state, setState] = useState<{ events: AdvisorEvent[]; verified: VerifiedSkill[]; live: LiveSessionRef[] }>();
	const [error, setError] = useState<unknown>();
	const [checking, setChecking] = useState<string>();
	const advisorJobs = data?.jobs.length;

	const load = useCallback(async () => {
		try {
			setState(await benchApi.advisor());
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), 15_000);
		return () => clearInterval(t);
	}, [load, advisorJobs, data?.settings.advisor.mode]);

	const settings = data?.settings;
	async function patch(p: Partial<BenchSettings["advisor"]>) {
		if (!settings) return;
		try {
			await benchApi.saveSettings({ advisor: { ...settings.advisor, ...p } });
			await reload();
		} catch (e) {
			setError(e);
		}
	}

	async function check(sessionId: string) {
		setChecking(sessionId);
		setError(undefined);
		try {
			await benchApi.advisorCheck(sessionId);
			await load();
		} catch (e) {
			setError(e);
		} finally {
			setChecking(undefined);
		}
	}

	return (
		<div className="col" style={{ gap: 14 }}>
			<ErrorLine error={error} />
			<section className="card">
				<header className="card__head">
					<Eyebrow ink>live advisor</Eyebrow>
					<div className="seg">
						{(["off", "suggest", "auto"] as const).map((m) => (
							<button key={m} type="button" className={settings?.advisor.mode === m ? "is-active" : ""} onClick={() => void patch({ mode: m })}>
								{m}
							</button>
						))}
					</div>
				</header>
				<div className="card__body col" style={{ gap: 10 }}>
					<p className="small soft" style={{ margin: 0 }}>
						Every few minutes a separate agent looks at what each live session did since its last look. When the session is starting a major step that a benchmark-verified skill fits, the skill is plugged in: sent mid-turn in <b>auto</b>, queued here for one click in <b>suggest</b>.
					</p>
					{settings && (
						<div className="row wrap" style={{ gap: 12 }}>
							<label className="field" style={{ width: 140 }}>
								<span>every (minutes)</span>
								<input className="input input--mono" type="number" min={1} defaultValue={settings.advisor.intervalMinutes} onBlur={(e) => void patch({ intervalMinutes: Math.max(1, Number(e.target.value)) })} />
							</label>
							<label className="field" style={{ width: 200 }}>
								<span>min pass-rate lift to count as verified</span>
								<input className="input input--mono" type="number" step={0.05} min={0} max={1} defaultValue={settings.advisor.minLift} onBlur={(e) => void patch({ minLift: Number(e.target.value) })} />
							</label>
							<label className="field" style={{ width: 200 }}>
								<span>advisor model</span>
								<input className="input input--mono" defaultValue={settings.advisor.model} onBlur={(e) => void patch({ model: e.target.value })} />
							</label>
						</div>
					)}
				</div>
			</section>

			<section className="card">
				<header className="card__head">
					<Eyebrow ink>verified skills · {state?.verified.length ?? 0}</Eyebrow>
				</header>
				<div className="card__body">
					{state && state.verified.length === 0 && (
						<EmptyState title="Nothing verified yet">A variant becomes available here once its latest finished run beats the raw arm of the same harness and model by the minimum lift.</EmptyState>
					)}
					{state?.verified.map((v) => (
						<div key={`${v.experimentId}:${v.variant.id}:${v.armId}`} className="row small" style={{ padding: "6px 0", borderBottom: "var(--hair)" }}>
							<strong>{v.variant.name}</strong>
							<span className="mono tiny muted">{v.variant.id}</span>
							<span className="pill pill--ink">+{pct(v.lift)}</span>
							<span className="mono tiny">
								{pct(v.passRate)} vs raw {pct(v.baselinePassRate)}
							</span>
							<span className="grow tiny muted truncate">on {v.taskTitles.join("; ")}</span>
							<Link className="tiny" to={`/bench/experiments?exp=${v.experimentId}`}>
								{v.experimentTitle}
							</Link>
						</div>
					))}
				</div>
			</section>

			<section className="card">
				<header className="card__head">
					<Eyebrow ink>live sessions · {state?.live.length ?? 0}</Eyebrow>
				</header>
				<div className="card__body">
					{state && state.live.length === 0 && <span className="small muted">No session is running right now.</span>}
					{state?.live.map((s) => (
						<div key={s.sessionId} className="row small" style={{ padding: "4px 0" }}>
							<Link className="mono" to={`/sessions/${s.sessionId}`}>
								{shortId(s.sessionId, 12)}
							</Link>
							{s.isStreaming && <span className="pill pill--live">streaming</span>}
							<span className="grow" />
							<button type="button" className="btn btn--small" disabled={checking === s.sessionId || (state?.verified.length ?? 0) === 0} onClick={() => void check(s.sessionId)}>
								{checking === s.sessionId ? "Checking…" : "Check now"}
							</button>
						</div>
					))}
				</div>
			</section>

			<section className="card">
				<header className="card__head">
					<Eyebrow ink>decisions</Eyebrow>
				</header>
				<div className="card__body col" style={{ gap: 8 }}>
					{state && state.events.length === 0 && <span className="small muted">The advisor has not looked at anything yet.</span>}
					{state?.events.map((e) => (
						<div key={e.id} className="col" style={{ gap: 4, paddingBottom: 8, borderBottom: "var(--hair)" }}>
							<div className="row small">
								<span className={`pill ${e.action === "sent" ? "pill--ink" : e.action === "suggested" ? "pill--live" : e.action === "error" ? "pill--fail" : "pill--ghost"}`}>{e.action}</span>
								{e.major && <span className="pill pill--ghost">major step</span>}
								<Link className="mono tiny" to={`/sessions/${e.sessionId}`}>
									{shortId(e.sessionId, 10)}
								</Link>
								<span className="grow truncate">{e.stepSummary}</span>
								<span className="mono tiny muted">{timeAgo(e.at)}</span>
								{e.action === "suggested" && (
									<button type="button" className="btn btn--primary btn--small" onClick={() => void benchApi.advisorSend(e.id).then(load).catch(setError)}>
										Send
									</button>
								)}
							</div>
							{e.chosenVariantIds.length > 0 && <div className="tiny muted">skills: {e.chosenVariantIds.join(", ")}</div>}
							{e.error && <div className="tiny accent-text">{e.error}</div>}
							{e.message && (
								<details>
									<summary className="tiny muted" style={{ cursor: "pointer" }}>
										message
									</summary>
									<pre className="codeblock">{e.message}</pre>
								</details>
							)}
						</div>
					))}
				</div>
			</section>
		</div>
	);
}

export function SettingsTab() {
	const { data, reload } = useBench();
	const [draft, setDraft] = useState<BenchSettings>();
	const [error, setError] = useState<unknown>();
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		if (data && !draft) setDraft(data.settings);
	}, [data, draft]);

	if (!draft) return null;

	async function save() {
		setError(undefined);
		try {
			await benchApi.saveSettings(draft!);
			await reload();
			setSaved(true);
			setTimeout(() => setSaved(false), 1500);
		} catch (e) {
			setError(e);
		}
	}

	return (
		<section className="card">
			<header className="card__head">
				<Eyebrow ink>benchmark settings</Eyebrow>
				<button type="button" className="btn btn--primary btn--small" onClick={() => void save()}>
					{saved ? "Saved" : "Save"}
				</button>
			</header>
			<div className="card__body bench-form">
				<ErrorLine error={error} />
				<p className="small soft" style={{ margin: 0 }}>
					Helper agents (capture drafter, trajectory miner, judge, advisor) run outside the harness under test. Claude Code is the default; with an OAuth token in the observer's environment it runs with a private config dir so your personal CLAUDE.md, skills and plugins cannot steer a judge.
				</p>
				<div className="two">
					<label className="field">
						<span>helper backend</span>
						<select className="select" value={draft.meta.backend} onChange={(e) => setDraft({ ...draft, meta: { ...draft.meta, backend: e.target.value as BenchSettings["meta"]["backend"] } })}>
							<option value="claude-code">claude code (claude -p --json-schema)</option>
							<option value="prime-agent">prime-agent (-p, own daemon)</option>
						</select>
					</label>
					<label className="field">
						<span>helper model</span>
						<input className="input input--mono" value={draft.meta.model} onChange={(e) => setDraft({ ...draft, meta: { ...draft.meta, model: e.target.value } })} />
					</label>
				</div>
				<div className="two">
					<label className="field">
						<span>judge model</span>
						<input className="input input--mono" value={draft.meta.judgeModel} onChange={(e) => setDraft({ ...draft, meta: { ...draft.meta, judgeModel: e.target.value } })} />
					</label>
					<label className="field">
						<span>auto-mine sessions idle for N minutes (empty = off)</span>
						<input
							className="input input--mono"
							type="number"
							min={1}
							value={draft.miner.autoOnIdleMinutes ?? ""}
							onChange={(e) => setDraft({ ...draft, miner: { autoOnIdleMinutes: e.target.value ? Number(e.target.value) : null } })}
						/>
					</label>
				</div>
				<div className="two">
					<label className="row small">
						<input type="checkbox" checked={draft.recorder.enabled} onChange={(e) => setDraft({ ...draft, recorder: { ...draft.recorder, enabled: e.target.checked } })} />
						record session workspaces (on every user message, and periodically while active)
					</label>
					<label className="field">
						<span>periodic recording every (minutes)</span>
						<input className="input input--mono" type="number" min={1} value={draft.recorder.periodicMinutes} onChange={(e) => setDraft({ ...draft, recorder: { ...draft.recorder, periodicMinutes: Number(e.target.value) } })} />
					</label>
				</div>
				<label className="row small">
					<input type="checkbox" checked={draft.intervention.enabled} onChange={(e) => setDraft({ ...draft, intervention: { enabled: e.target.checked } })} />
					turn "benchmark this" messages in live sessions into checkpoint tasks
				</label>
			</div>
		</section>
	);
}
