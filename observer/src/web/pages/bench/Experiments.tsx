import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Arm, Experiment, RunSummary, Variant } from "../../../shared/bench.ts";
import { ConfirmDialog, EmptyState, ErrorLine, Eyebrow } from "../../components/common.tsx";
import { benchApi } from "../../lib/bench-api.ts";
import { duration, shortId, timeAgo, usd } from "../../lib/format.ts";
import { pct, useBench } from "./Bench.tsx";

export function ExperimentsTab() {
	const { data } = useBench();
	const [params, setParams] = useSearchParams();
	const [creating, setCreating] = useState(false);
	const experiments = data?.experiments ?? [];
	const selected = params.get("exp") ?? experiments[0]?.id;

	return (
		<>
			<div className="row" style={{ marginBottom: 12 }}>
				<span className="small soft grow">Describe a harness change; the helper writes variants as SKILL.md; every variant runs against your checkpoints next to the raw harnesses.</span>
				<button type="button" className="btn btn--primary btn--small" onClick={() => setCreating(true)}>
					New experiment
				</button>
			</div>
			<div className="bench-split">
				<div className="card bench-list">
					{experiments.length === 0 && <EmptyState title="No experiments">Start with the change you want to test.</EmptyState>}
					{experiments.map((x) => {
						const last = data?.runs.find((r) => r.runId === x.lastRunId);
						return (
							<button key={x.id} type="button" className={`bench-item${x.id === selected ? " is-active" : ""}`} onClick={() => setParams({ exp: x.id })}>
								<div className="bench-item__title">{x.title}</div>
								<div className="bench-item__meta">
									<span className="tiny muted">
										{x.taskIds.length} tasks · {x.variants.length} variants · {x.arms.length} arms
									</span>
									{last && <span className={`pill ${last.status === "running" ? "pill--live" : "pill--ghost"}`}>{last.status}</span>}
									{x.schedule && <span className="tiny muted">every {x.schedule.everyDays}d</span>}
								</div>
							</button>
						);
					})}
				</div>
				<div>{selected && <ExperimentDetail key={selected} id={selected} onDeleted={() => setParams({})} />}</div>
			</div>
			{creating && (
				<NewExperimentDialog
					onClose={() => setCreating(false)}
					onCreated={(id) => {
						setCreating(false);
						setParams({ exp: id });
					}}
				/>
			)}
		</>
	);
}

function ExperimentDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
	const { data } = useBench();
	const [exp, setExp] = useState<Experiment>();
	const [draft, setDraft] = useState<Experiment>();
	const [runs, setRuns] = useState<RunSummary[]>([]);
	const [active, setActive] = useState(false);
	const [error, setError] = useState<unknown>();
	const [confirm, setConfirm] = useState<"run" | "delete" | { promote: Variant } | undefined>();
	const [genCount, setGenCount] = useState(1);
	const serverExp = data?.experiments.find((x) => x.id === id);

	const load = useCallback(async () => {
		try {
			const r = await benchApi.experiment(id);
			setExp(r.experiment);
			setDraft((d) => (d && d.updatedAt === r.experiment.updatedAt ? d : r.experiment));
			setRuns(r.runs);
			setActive(r.active);
		} catch (e) {
			setError(e);
		}
	}, [id]);

	useEffect(() => {
		void load();
	}, [load]);

	const clean = !!exp && !!draft && JSON.stringify(exp) === JSON.stringify(draft);
	const runsKey = data?.runs.map((r) => `${r.runId}:${r.status}:${r.arms.map((a) => a.finished).join(",")}`).join("|");
	useEffect(() => {
		if (!serverExp || !exp) return;
		if (serverExp.updatedAt !== exp.updatedAt && clean) void load();
	}, [serverExp, exp, clean, load]);
	useEffect(() => {
		if (runsKey !== undefined) void load();
		// load() replaces the draft only when the saved version changed, so this is safe mid-edit
	}, [runsKey, load]);

	if (!draft || !exp) return <ErrorLine error={error} />;
	const set = <K extends keyof Experiment>(k: K, v: Experiment[K]) => setDraft({ ...draft, [k]: v });
	const tasks = data?.tasks.filter((t) => t.status !== "archived") ?? [];
	const trialCount = draft.taskIds.length * draft.arms.length * draft.repeats;

	async function save(): Promise<boolean> {
		setError(undefined);
		try {
			const next = await benchApi.updateExperiment(id, draft!);
			setExp(next);
			setDraft(next);
			return true;
		} catch (e) {
			setError(e);
			return false;
		}
	}

	async function run() {
		setConfirm(undefined);
		if (!clean && !(await save())) return;
		try {
			await benchApi.run(id);
			await load();
		} catch (e) {
			setError(e);
		}
	}

	const updateVariant = (i: number, patch: Partial<Variant>) => set("variants", draft.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));
	const updateArm = (i: number, patch: Partial<Arm>) => set("arms", draft.arms.map((a, j) => (j === i ? { ...a, ...patch } : a)));
	const latest = runs[0];

	return (
		<div className="col" style={{ gap: 14 }}>
			<ErrorLine error={error} />
			<section className="card">
				<header className="card__head">
					<Eyebrow ink>experiment</Eyebrow>
					<div className="row">
						<button type="button" className="btn btn--small" disabled={clean} onClick={() => setDraft(exp)}>
							Revert
						</button>
						<button type="button" className="btn btn--small" disabled={clean} onClick={() => void save()}>
							Save
						</button>
						<button type="button" className="btn btn--accent btn--small" disabled={active || trialCount === 0} onClick={() => setConfirm("run")}>
							{active ? "Running…" : `Run ${trialCount} trial${trialCount === 1 ? "" : "s"}`}
						</button>
					</div>
				</header>
				<div className="card__body bench-form">
					<label className="field">
						<span>title</span>
						<input className="input" value={draft.title} onChange={(e) => set("title", e.target.value)} />
					</label>
					<label className="field">
						<span>the change to test</span>
						<textarea className="textarea" rows={4} value={draft.description} onChange={(e) => set("description", e.target.value)} />
					</label>
					<div className="field col">
						<span className="eyebrow">checkpoints ({draft.taskIds.length})</span>
						{tasks.length === 0 && <span className="small muted">No tasks yet.</span>}
						<div className="col" style={{ gap: 4 }}>
							{tasks.map((t) => (
								<label key={t.id} className="row small">
									<input
										type="checkbox"
										checked={draft.taskIds.includes(t.id)}
										onChange={(e) => set("taskIds", e.target.checked ? [...draft.taskIds, t.id] : draft.taskIds.filter((x) => x !== t.id))}
									/>
									<span className="grow truncate">{t.title}</span>
									<span className={`pill ${t.status === "ready" ? "pill--ink" : "pill--ghost"}`}>{t.status}</span>
									{t.finalState.length === 0 && <span className="tiny accent-text">no criteria</span>}
								</label>
							))}
						</div>
					</div>
					<div className="two">
						<div className="row" style={{ gap: 12 }}>
							<label className="field" style={{ width: 110 }}>
								<span>repeats</span>
								<input className="input input--mono" type="number" min={1} max={20} value={draft.repeats} onChange={(e) => set("repeats", Number(e.target.value))} />
							</label>
							<label className="field" style={{ width: 110 }}>
								<span>concurrency</span>
								<input className="input input--mono" type="number" min={1} max={8} value={draft.concurrency} onChange={(e) => set("concurrency", Number(e.target.value))} />
							</label>
						</div>
						<label className="field">
							<span>re-run every N days (0 = never)</span>
							<input className="input input--mono" type="number" min={0} value={draft.schedule?.everyDays ?? 0} onChange={(e) => set("schedule", Number(e.target.value) > 0 ? { everyDays: Number(e.target.value) } : null)} />
						</label>
					</div>
				</div>
			</section>

			<section className="card">
				<header className="card__head">
					<Eyebrow ink>variants · {draft.variants.length}</Eyebrow>
					<div className="row">
						<input className="input input--mono" type="number" min={1} max={6} value={genCount} onChange={(e) => setGenCount(Number(e.target.value))} style={{ width: 64 }} />
						<button type="button" className="btn btn--small" disabled={!clean} title={clean ? "" : "save first"} onClick={() => void benchApi.generateVariants(id, genCount).catch(setError)}>
							Write more with the helper
						</button>
						<button
							type="button"
							className="btn btn--small"
							onClick={() => set("variants", [...draft.variants, { id: `variant-${draft.variants.length + 1}`, name: `variant ${draft.variants.length + 1}`, skill: "---\nname: \ndescription: \n---\n\n" }])}
						>
							Add by hand
						</button>
					</div>
				</header>
				<div className="card__body col" style={{ gap: 12 }}>
					{draft.variants.length === 0 && <span className="small muted">No variants yet. The raw arms still run as a baseline.</span>}
					{draft.variants.map((v, i) => (
						<details key={`${v.id}:${i}`} className="variant">
							<summary className="row">
								<strong className="small">{v.name}</strong>
								<span className="mono tiny muted">{v.id}</span>
								{v.promoted && <span className="pill pill--ink">installed</span>}
								<span className="grow tiny muted truncate">{v.notes}</span>
							</summary>
							<div className="bench-form" style={{ marginTop: 8 }}>
								<div className="two">
									<label className="field">
										<span>name</span>
										<input className="input" value={v.name} onChange={(e) => updateVariant(i, { name: e.target.value })} />
									</label>
									<label className="field">
										<span>id</span>
										<input className="input input--mono" value={v.id} onChange={(e) => updateVariant(i, { id: e.target.value })} />
									</label>
								</div>
								<label className="field">
									<span>SKILL.md</span>
									<textarea className="textarea textarea--mono" rows={14} value={v.skill} onChange={(e) => updateVariant(i, { skill: e.target.value })} />
								</label>
								<div className="row">
									<button type="button" className="btn btn--ghost btn--small" onClick={() => set("variants", draft.variants.filter((_, j) => j !== i))}>
										Remove
									</button>
									<span className="grow" />
									<button type="button" className="btn btn--small" disabled={!clean} onClick={() => setConfirm({ promote: v })}>
										Install as a live skill
									</button>
								</div>
							</div>
						</details>
					))}
				</div>
			</section>

			<section className="card">
				<header className="card__head">
					<Eyebrow ink>arms · {draft.arms.length}</Eyebrow>
					<div className="row">
						<button
							type="button"
							className="btn btn--small"
							onClick={() =>
								set("arms", [
									...draft.arms,
									{ id: `arm-${draft.arms.length + 1}`, label: `arm ${draft.arms.length + 1}`, harness: "prime-agent", variantId: null, model: "anthropic/claude-opus-5", memory: "snapshot", insertion: "system-prompt" },
								])
							}
						>
							Add arm
						</button>
					</div>
				</header>
				<div className="card__body matrix">
					<table className="table table--tight">
						<thead>
							<tr>
								<th>label</th>
								<th>harness</th>
								<th>variant</th>
								<th>model</th>
								<th>memory</th>
								<th>insert as</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{draft.arms.map((a, i) => (
								<tr key={`${a.id}:${i}`}>
									<td>
										<input className="input" value={a.label} onChange={(e) => updateArm(i, { label: e.target.value })} />
									</td>
									<td>
										<select className="select" value={a.harness} onChange={(e) => updateArm(i, { harness: e.target.value as Arm["harness"], memory: e.target.value === "claude-code" ? "none" : a.memory })}>
											<option value="prime-agent">prime-agent</option>
											<option value="claude-code">claude code</option>
										</select>
									</td>
									<td>
										<select className="select" value={a.variantId ?? ""} onChange={(e) => updateArm(i, { variantId: e.target.value || null })}>
											<option value="">raw (none)</option>
											{draft.variants.map((v) => (
												<option key={v.id} value={v.id}>
													{v.name}
												</option>
											))}
										</select>
									</td>
									<td>
										<input className="input input--mono" value={a.model} onChange={(e) => updateArm(i, { model: e.target.value })} />
									</td>
									<td>
										<select className="select" value={a.memory} disabled={a.harness === "claude-code"} onChange={(e) => updateArm(i, { memory: e.target.value as Arm["memory"] })}>
											<option value="snapshot">as at checkpoint</option>
											<option value="current">today's memory</option>
											<option value="none">no memory</option>
										</select>
									</td>
									<td>
										<select className="select" value={a.insertion} onChange={(e) => updateArm(i, { insertion: e.target.value as Arm["insertion"] })}>
											<option value="system-prompt">system prompt</option>
											<option value="first-message">first message</option>
										</select>
									</td>
									<td>
										<button type="button" className="btn btn--ghost btn--small" onClick={() => set("arms", draft.arms.filter((_, j) => j !== i))}>
											remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			{latest && <ResultsCard exp={exp} summary={latest} />}
			{runs.length > 1 && <HistoryCard runs={runs} />}

			<div className="row">
				<span className="grow" />
				<button type="button" className="btn btn--danger btn--small" onClick={() => setConfirm("delete")}>
					Delete experiment
				</button>
			</div>

			{confirm === "run" && (
				<ConfirmDialog
					title="Run experiment"
					confirmLabel={`Start ${trialCount} trials`}
					body={
						<p>
							{draft.taskIds.length} checkpoint(s) × {draft.arms.length} arm(s) × {draft.repeats} repeat(s), {draft.concurrency} at a time. Each trial is a full agent episode plus a judge call, billed to the configured providers.
						</p>
					}
					onCancel={() => setConfirm(undefined)}
					onConfirm={() => void run()}
				/>
			)}
			{confirm === "delete" && (
				<ConfirmDialog
					title="Delete experiment"
					danger
					confirmLabel="Delete"
					body={<p>Runs stay on disk; the experiment definition is removed.</p>}
					onCancel={() => setConfirm(undefined)}
					onConfirm={async () => {
						setConfirm(undefined);
						try {
							await benchApi.deleteExperiment(id);
							onDeleted();
						} catch (e) {
							setError(e);
						}
					}}
				/>
			)}
			{typeof confirm === "object" && (
				<ConfirmDialog
					title="Install as a live skill"
					confirmLabel="Install"
					body={
						<p>
							Writes <span className="code">{confirm.promote.id}/SKILL.md</span> into the harness's global skills directory. Every new prime-agent session will see it, and future runs with "today's memory" will include it.
						</p>
					}
					onCancel={() => setConfirm(undefined)}
					onConfirm={async () => {
						const v = confirm.promote;
						setConfirm(undefined);
						try {
							await benchApi.promote(id, v.id);
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

function ResultsCard({ exp, summary }: { exp: Experiment; summary: RunSummary }) {
	const { data } = useBench();
	const title = (taskId: string) => data?.tasks.find((t) => t.id === taskId)?.title ?? shortId(taskId, 14);
	const taskIds = [...new Set(summary.cells.map((c) => c.taskId))];
	const bestRate = Math.max(...summary.arms.map((a) => a.passRate ?? -1));
	return (
		<section className="card">
			<header className="card__head">
				<div className="row grow">
					<Eyebrow ink>latest run</Eyebrow>
					<span className={`pill ${summary.status === "running" ? "pill--live" : "pill--ghost"}`}>{summary.status}</span>
					<span className="mono tiny muted">{timeAgo(summary.createdAt)}</span>
				</div>
				<Link className="btn btn--small" to={`/bench/runs?run=${summary.runId}`}>
					trials
				</Link>
			</header>
			<div className="card__body matrix">
				<table className="table table--tight">
					<thead>
						<tr>
							<th>arm</th>
							<th>pass rate</th>
							<th>mean score</th>
							<th>finished</th>
							<th>cost</th>
							<th>mean time</th>
						</tr>
					</thead>
					<tbody>
						{summary.arms.map((a) => (
							<tr key={a.armId}>
								<td className="small">
									{a.label}
									{a.passRate !== null && a.passRate === bestRate && bestRate > 0 && <span className="pill pill--ink" style={{ marginLeft: 6 }}>best</span>}
								</td>
								<td className="mono small">
									<span className="bar-inline">
										<span style={{ width: `${Math.round((a.passRate ?? 0) * 100)}%` }} />
									</span>{" "}
									{pct(a.passRate)}
								</td>
								<td className="mono small">{pct(a.meanScore)}</td>
								<td className="mono small">
									{a.finished}/{a.trials}
								</td>
								<td className="mono small">{usd(a.costUsd)}</td>
								<td className="mono small">{a.meanDurationMs ? duration(a.meanDurationMs) : "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
				<table className="table table--tight" style={{ marginTop: 14 }}>
					<thead>
						<tr>
							<th>checkpoint</th>
							{summary.arms.map((a) => (
								<th key={a.armId}>{a.label}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{taskIds.map((t) => (
							<tr key={t}>
								<td className="small">{title(t)}</td>
								{summary.arms.map((a) => {
									const c = summary.cells.find((x) => x.taskId === t && x.armId === a.armId);
									const cls = !c || c.finished === 0 ? "" : c.passed === c.finished ? "cell--pass" : c.passed === 0 ? "cell--fail" : "";
									return (
										<td key={a.armId} className={`cell ${cls}`}>
											{c && c.finished > 0 ? `${c.passed}/${c.finished}` : "—"}
											{c?.meanScore !== null && c?.meanScore !== undefined && <span className="tiny muted"> · {pct(c.meanScore)}</span>}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
				{exp.variants.length === 0 && <p className="tiny muted">Only raw arms ran: this is the baseline for future variants.</p>}
			</div>
		</section>
	);
}

function HistoryCard({ runs }: { runs: RunSummary[] }) {
	const labels = [...new Set(runs.flatMap((r) => r.arms.map((a) => a.label)))];
	return (
		<section className="card">
			<header className="card__head">
				<Eyebrow ink>history · pass rate per run</Eyebrow>
			</header>
			<div className="card__body matrix">
				<table className="table table--tight">
					<thead>
						<tr>
							<th>run</th>
							{labels.map((l) => (
								<th key={l}>{l}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{runs.map((r) => (
							<tr key={r.runId}>
								<td className="mono tiny">
									<Link to={`/bench/runs?run=${r.runId}`}>{timeAgo(r.createdAt)}</Link> · {r.status}
								</td>
								{labels.map((l) => (
									<td key={l} className="mono small">
										{pct(r.arms.find((a) => a.label === l)?.passRate)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function NewExperimentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
	const { data } = useBench();
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [taskIds, setTaskIds] = useState<string[]>([]);
	const [variantCount, setVariantCount] = useState(3);
	const [paModel, setPaModel] = useState("anthropic/claude-opus-5");
	const [ccModel, setCcModel] = useState("opus");
	const [withCc, setWithCc] = useState(true);
	const [error, setError] = useState<unknown>();
	const [busy, setBusy] = useState(false);
	const tasks = data?.tasks.filter((t) => t.status !== "archived") ?? [];

	async function create() {
		setBusy(true);
		setError(undefined);
		try {
			const r = await benchApi.createExperiment({ title, description, taskIds, variantCount, models: { primeAgent: paModel, claudeCode: ccModel }, includeClaudeCode: withCc });
			onCreated(r.experiment.id);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal" onClick={onClose} role="presentation">
			<div className="modal__card modal__card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<Eyebrow ink>new experiment</Eyebrow>
				<div className="modal__body bench-form">
					<ErrorLine error={error} />
					<label className="field">
						<span>title</span>
						<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Research agent before major decisions" />
					</label>
					<label className="field">
						<span>describe the change to test</span>
						<textarea
							className="textarea"
							rows={5}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Before any major decision, research only carefully selected expert sources (YouTube breakdowns, Skool and Whop communities, GitHub) and write the findings down, then plan in the smallest possible steps."
						/>
					</label>
					<div className="field col">
						<span className="eyebrow">checkpoints</span>
						{tasks.length === 0 && <span className="small muted">No tasks yet; you can add them later.</span>}
						{tasks.map((t) => (
							<label key={t.id} className="row small">
								<input type="checkbox" checked={taskIds.includes(t.id)} onChange={(e) => setTaskIds(e.target.checked ? [...taskIds, t.id] : taskIds.filter((x) => x !== t.id))} />
								<span className="grow truncate">{t.title}</span>
								<span className="pill pill--ghost">{t.status}</span>
							</label>
						))}
					</div>
					<div className="two">
						<label className="field">
							<span>variants to write now (0-6)</span>
							<input className="input input--mono" type="number" min={0} max={6} value={variantCount} onChange={(e) => setVariantCount(Number(e.target.value))} />
						</label>
						<label className="row small" style={{ alignSelf: "end", paddingBottom: 8 }}>
							<input type="checkbox" checked={withCc} onChange={(e) => setWithCc(e.target.checked)} />
							include Claude Code arms (raw + each variant)
						</label>
					</div>
					<div className="two">
						<label className="field">
							<span>prime-agent model</span>
							<input className="input input--mono" value={paModel} onChange={(e) => setPaModel(e.target.value)} />
						</label>
						<label className="field">
							<span>claude code model</span>
							<input className="input input--mono" value={ccModel} onChange={(e) => setCcModel(e.target.value)} disabled={!withCc} />
						</label>
					</div>
				</div>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="button" className="btn btn--primary" disabled={!title.trim() || busy} onClick={() => void create()}>
						Create
					</button>
				</div>
			</div>
		</div>
	);
}
