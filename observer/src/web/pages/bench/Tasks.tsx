import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { BenchTask, FinalStateCriterion, TimelineEntry } from "../../../shared/bench.ts";
import { ConfirmDialog, EmptyState, ErrorLine, Eyebrow, KV, MonoId } from "../../components/common.tsx";
import { benchApi } from "../../lib/bench-api.ts";
import { dateTime, shortId, timeAgo } from "../../lib/format.ts";
import { fleetStore } from "../../state/app-state.ts";
import { useStore } from "../../state/store.ts";
import { pct, TimelineRows, useBench } from "./Bench.tsx";

export function TasksTab() {
	const { data } = useBench();
	const [params, setParams] = useSearchParams();
	const [capturing, setCapturing] = useState(false);
	const [filter, setFilter] = useState<"active" | "archived">("active");
	const tasks = (data?.tasks ?? []).filter((t) => (filter === "archived" ? t.status === "archived" : t.status !== "archived"));
	const selected = params.get("task") ?? tasks[0]?.id;

	// Latest pass rate per task across all runs, for the list.
	const latest = useMemo(() => {
		const out = new Map<string, string>();
		for (const run of data?.runs ?? []) {
			for (const cell of run.cells) {
				if (out.has(cell.taskId) || cell.finished === 0) continue;
				const passed = run.cells.filter((c) => c.taskId === cell.taskId).reduce((s, c) => s + c.passed, 0);
				const finished = run.cells.filter((c) => c.taskId === cell.taskId).reduce((s, c) => s + c.finished, 0);
				out.set(cell.taskId, `${passed}/${finished} passed`);
			}
		}
		return out;
	}, [data]);

	return (
		<>
			<div className="row" style={{ marginBottom: 12 }}>
				<div className="seg">
					{(["active", "archived"] as const).map((f) => (
						<button key={f} type="button" className={filter === f ? "is-active" : ""} onClick={() => setFilter(f)}>
							{f}
						</button>
					))}
				</div>
				<span className="grow" />
				<button type="button" className="btn btn--primary btn--small" onClick={() => setCapturing(true)}>
					Capture checkpoint
				</button>
			</div>
			<div className="bench-split">
				<div className="card bench-list">
					{tasks.length === 0 && (
						<EmptyState title="No checkpoint tasks yet">Capture one from a session, accept a mined candidate, or tell a live agent "benchmark this".</EmptyState>
					)}
					{tasks.map((t) => (
						<button key={t.id} type="button" className={`bench-item${t.id === selected ? " is-active" : ""}`} onClick={() => setParams({ task: t.id })}>
							<div className="bench-item__title">{t.title || "(untitled)"}</div>
							<div className="bench-item__meta">
								<span className={`pill ${t.status === "ready" ? "pill--ink" : "pill--ghost"}`}>{t.status}</span>
								<span className="pill pill--ghost">{t.source}</span>
								<span className="tiny muted">{t.finalState.length} criteria</span>
								{latest.get(t.id) && <span className="tiny muted">{latest.get(t.id)}</span>}
								<span className="mono tiny muted">{timeAgo(t.createdAt)}</span>
							</div>
						</button>
					))}
				</div>
				<div>{selected ? <TaskDetail key={selected} id={selected} onDeleted={() => setParams({})} /> : null}</div>
			</div>
			{capturing && <CaptureDialog onClose={() => setCapturing(false)} />}
		</>
	);
}

function TaskDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
	const { data } = useBench();
	const [task, setTask] = useState<BenchTask>();
	const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
	const [draft, setDraft] = useState<BenchTask>();
	const [error, setError] = useState<unknown>();
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const serverTask = data?.tasks.find((t) => t.id === id);

	const load = useCallback(async () => {
		try {
			const r = await benchApi.task(id);
			setTask(r.task);
			setTimeline(r.timeline);
			setDraft((d) => (d && d.updatedAt === r.task.updatedAt ? d : r.task));
		} catch (e) {
			setError(e);
		}
	}, [id]);

	useEffect(() => {
		void load();
	}, [load]);

	// A capture draft lands asynchronously; pick it up unless the operator is mid-edit.
	useEffect(() => {
		if (serverTask && task && serverTask.updatedAt !== task.updatedAt && JSON.stringify(draft) === JSON.stringify(task)) void load();
	}, [serverTask, task, draft, load]);

	if (!draft || !task) return <ErrorLine error={error} />;
	const dirty = JSON.stringify(draft) !== JSON.stringify(task);
	const set = <K extends keyof BenchTask>(k: K, v: BenchTask[K]) => setDraft({ ...draft, [k]: v });

	async function save(patch?: Partial<BenchTask>) {
		setSaving(true);
		setError(undefined);
		try {
			const next = await benchApi.updateTask(id, { ...draft, ...patch });
			setTask(next);
			setDraft(next);
		} catch (e) {
			setError(e);
		} finally {
			setSaving(false);
		}
	}

	const w = task.snapshot.workspace;
	const lagMin = w.lagSeconds !== undefined ? Math.round(w.lagSeconds / 60) : undefined;

	return (
		<div className="col" style={{ gap: 14 }}>
			<ErrorLine error={error} />
			<section className="card">
				<header className="card__head">
					<Eyebrow ink>checkpoint</Eyebrow>
					<div className="row">
						<select className="select" value={draft.status} onChange={(e) => set("status", e.target.value as BenchTask["status"])} style={{ width: 120 }}>
							<option value="draft">draft</option>
							<option value="ready">ready</option>
							<option value="archived">archived</option>
						</select>
						<button type="button" className="btn btn--small" disabled={!dirty || saving} onClick={() => setDraft(task)}>
							Revert
						</button>
						<button type="button" className="btn btn--primary btn--small" disabled={!dirty || saving} onClick={() => void save()}>
							{saving ? "Saving…" : "Save"}
						</button>
					</div>
				</header>
				<div className="card__body bench-form">
					{task.goal === "" && task.finalState.length === 0 && (
						<div className="banner banner--info">The helper is still drafting the goal and final state, or drafting was skipped. You can write them yourself.</div>
					)}
					<label className="field">
						<span>title</span>
						<input className="input" value={draft.title} onChange={(e) => set("title", e.target.value)} />
					</label>
					<label className="field">
						<span>prompt the agent receives</span>
						<textarea className="textarea textarea--mono" rows={3} value={draft.prompt} onChange={(e) => set("prompt", e.target.value)} />
					</label>
					<label className="field">
						<span>goal</span>
						<textarea className="textarea" rows={3} value={draft.goal} onChange={(e) => set("goal", e.target.value)} />
					</label>
					<label className="field">
						<span>desired trajectory (judge only, never shown to the agent)</span>
						<textarea className="textarea" rows={3} value={draft.desiredTrajectory ?? ""} onChange={(e) => set("desiredTrajectory", e.target.value)} />
					</label>
					<Criteria value={draft.finalState} onChange={(v) => set("finalState", v)} />
					<label className="field">
						<span>judge instructions</span>
						<textarea className="textarea" rows={4} value={draft.judgeInstructions} onChange={(e) => set("judgeInstructions", e.target.value)} />
					</label>
					<div className="two">
						<label className="field">
							<span>tags (comma separated)</span>
							<input className="input" value={draft.tags.join(", ")} onChange={(e) => set("tags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
						</label>
						<div className="row" style={{ gap: 12, alignItems: "end" }}>
							<label className="field" style={{ width: 140 }}>
								<span>timeout (min)</span>
								<input className="input input--mono" type="number" min={1} value={draft.runOptions.timeoutMinutes} onChange={(e) => set("runOptions", { ...draft.runOptions, timeoutMinutes: Number(e.target.value) })} />
							</label>
							<label className="row small" style={{ paddingBottom: 8 }}>
								<input type="checkbox" checked={draft.runOptions.autonomous} onChange={(e) => set("runOptions", { ...draft.runOptions, autonomous: e.target.checked })} />
								autonomous (prime-agent keeps going without a human)
							</label>
						</div>
					</div>
				</div>
			</section>

			<section className="card">
				<header className="card__head">
					<Eyebrow ink>frozen snapshot</Eyebrow>
					<button type="button" className="btn btn--danger btn--small" onClick={() => setConfirmDelete(true)}>
						Delete task
					</button>
				</header>
				<div className="card__body">
					<KV k="origin session" v={<Link to={`/sessions/${task.origin.sessionId}`}>{shortId(task.origin.sessionId, 12)}</Link>} />
					<KV k="anchor" v={<MonoId id={task.origin.anchorEntryId} />} />
					<KV k="anchored at" v={dateTime(task.origin.anchorAt)} mono />
					<KV k="cut" v={task.origin.cut === "before-user-message" ? "before the user message (its text is the prompt)" : "mid-turn (agent is asked to continue)"} />
					<KV k="original model" v={[task.origin.provider, task.origin.model].filter(Boolean).join("/") || undefined} mono />
					<KV k="harness version" v={task.origin.harnessVersion} mono />
					<KV k="transcript" v={`${task.snapshot.messageCount} messages · ${task.snapshot.entryCount} entries`} mono />
					<KV
						k="workspace"
						v={
							w.commit ? (
								<span>
									{shortId(w.commit, 10)} · {w.fileCount ?? "?"} files ·{" "}
									<span className={lagMin !== undefined && (lagMin > 15 || lagMin < 0) ? "accent-text" : ""}>
										{lagMin === undefined ? "" : lagMin >= 0 ? `recorded ${lagMin} min before the checkpoint` : `recorded ${-lagMin} min after the checkpoint (fallback)`}
									</span>
								</span>
							) : (
								<span className="accent-text">not recorded: trials start in an empty directory</span>
							)
						}
						mono
					/>
					<KV k="cwd" v={w.cwd} mono />
					<details style={{ marginTop: 10 }}>
						<summary className="eyebrow" style={{ cursor: "pointer" }}>
							memory · {task.snapshot.harness.includedEntries.length} kept · {task.snapshot.harness.excludedEntries.length} excluded · skills {task.snapshot.harness.includedSkills.length} kept · {task.snapshot.harness.excludedSkills.length} excluded
						</summary>
						<div className="col small" style={{ marginTop: 8 }}>
							{task.snapshot.harness.includedEntries.map((e) => (
								<div key={`${e.scope}:${e.kind}:${e.id}`}>
									<span className="pill pill--ghost">{e.scope} {e.kind}</span> {e.title}
								</div>
							))}
							{task.snapshot.harness.excludedEntries.map((e) => (
								<div key={`x:${e.scope}:${e.kind}:${e.id}`} className="muted">
									<span className="pill pill--fail">excluded</span> {e.title} — {e.reason}
								</div>
							))}
							{task.snapshot.harness.includedSkills.map((s) => (
								<div key={`s:${s}`}>
									<span className="pill pill--ghost">skill</span> {s}
								</div>
							))}
							{task.snapshot.harness.excludedSkills.map((s) => (
								<div key={`xs:${s.name}`} className="muted">
									<span className="pill pill--fail">excluded skill</span> {s.name} — {s.reason}
								</div>
							))}
						</div>
					</details>
					<details style={{ marginTop: 10 }}>
						<summary className="eyebrow" style={{ cursor: "pointer" }}>
							transcript up to the checkpoint (last {Math.min(40, timeline.length)} of {timeline.length})
						</summary>
						<div style={{ marginTop: 8 }}>
							<TimelineRows rows={timeline.slice(-40)} />
						</div>
					</details>
				</div>
			</section>
			<RunsForTask taskId={id} />
			{confirmDelete && (
				<ConfirmDialog
					title="Delete task"
					danger
					confirmLabel="Delete"
					body={<p>This removes the task and its frozen snapshot. Past runs keep their results.</p>}
					onCancel={() => setConfirmDelete(false)}
					onConfirm={async () => {
						setConfirmDelete(false);
						try {
							await benchApi.deleteTask(id);
							onDeleted();
						} catch (e) {
							setError(e);
						}
					}}
				/>
			)}
		</div>
	);
}

function RunsForTask({ taskId }: { taskId: string }) {
	const { data } = useBench();
	const rows = (data?.runs ?? []).filter((r) => r.cells.some((c) => c.taskId === taskId && c.finished > 0)).slice(0, 8);
	if (rows.length === 0) return null;
	const expTitle = (runId: string) => data?.experiments.find((e) => e.lastRunId === runId)?.title;
	return (
		<section className="card">
			<header className="card__head">
				<Eyebrow ink>results on this checkpoint</Eyebrow>
			</header>
			<div className="card__body matrix">
				<table className="table table--tight">
					<thead>
						<tr>
							<th>run</th>
							<th>arm</th>
							<th>passed</th>
							<th>mean score</th>
						</tr>
					</thead>
					<tbody>
						{rows.flatMap((r) =>
							r.cells
								.filter((c) => c.taskId === taskId && c.finished > 0)
								.map((c) => (
									<tr key={`${r.runId}:${c.armId}`}>
										<td className="mono tiny">
											<Link to={`/bench/runs?run=${r.runId}`}>{expTitle(r.runId) ?? shortId(r.runId, 16)}</Link> · {timeAgo(r.createdAt)}
										</td>
										<td className="small">{r.arms.find((a) => a.armId === c.armId)?.label ?? c.armId}</td>
										<td className="mono small">
											{c.passed}/{c.finished}
										</td>
										<td className="mono small">{pct(c.meanScore)}</td>
									</tr>
								)),
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function Criteria({ value, onChange }: { value: FinalStateCriterion[]; onChange: (v: FinalStateCriterion[]) => void }) {
	const update = (i: number, patch: Partial<FinalStateCriterion>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
	return (
		<div className="field col" style={{ gap: 8 }}>
			<span className="eyebrow">final-state criteria ({value.filter((c) => c.required).length} required)</span>
			{value.map((c, i) => (
				<div key={c.id} className="criterion">
					<textarea className="textarea" rows={2} value={c.text} onChange={(e) => update(i, { text: e.target.value })} />
					<label className="row tiny" title="A required criterion fails the trial on its own">
						<input type="checkbox" checked={c.required} onChange={(e) => update(i, { required: e.target.checked })} />
						required
					</label>
					<button type="button" className="btn btn--ghost btn--small" onClick={() => onChange(value.filter((_, j) => j !== i))}>
						remove
					</button>
				</div>
			))}
			<div>
				<button type="button" className="btn btn--small" onClick={() => onChange([...value, { id: `c${Date.now().toString(36)}`, text: "", required: false }])}>
					Add criterion
				</button>
			</div>
		</div>
	);
}

/** Pick a session and the moment to freeze. Used here and from the session page. */
export function CaptureDialog({ onClose, sessionId: fixedSession }: { onClose: () => void; sessionId?: string }) {
	const fleet = useStore(fleetStore);
	const [sessionId, setSessionId] = useState(fixedSession ?? "");
	const [rows, setRows] = useState<TimelineEntry[]>([]);
	const [anchor, setAnchor] = useState<string>();
	const [showAll, setShowAll] = useState(false);
	const [title, setTitle] = useState("");
	const [desired, setDesired] = useState("");
	const [noDraft, setNoDraft] = useState(false);
	const [error, setError] = useState<unknown>();
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);

	const sessions = useMemo(() => (fleet?.roots ?? []).map((n) => ({ id: n.sessionId, label: `${n.name ?? n.firstMessage?.slice(0, 60) ?? shortId(n.sessionId)}${n.activeSessionId ? " · live" : ""}` })), [fleet]);

	useEffect(() => {
		if (!sessionId) return;
		setRows([]);
		setAnchor(undefined);
		benchApi
			.timeline(sessionId)
			.then((r) => {
				setRows(r.rows);
				setAnchor([...r.rows].reverse().find((x) => x.role === "user")?.id);
			})
			.catch(setError);
	}, [sessionId]);

	const visible = showAll ? rows : rows.filter((r) => r.role === "user");

	async function submit() {
		setBusy(true);
		setError(undefined);
		try {
			await benchApi.capture({ sessionId, anchorEntryId: anchor, title: title || undefined, desiredTrajectory: desired || undefined, noDraft });
			setDone(true);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal" onClick={onClose} role="presentation">
			<div className="modal__card modal__card--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<Eyebrow ink>capture a checkpoint</Eyebrow>
				<div className="modal__body bench-form">
					{done ? (
						<div className="banner banner--info">Capturing. The snapshot is written now; the helper drafts the goal and final state in the background. It shows up under tasks as a draft.</div>
					) : (
						<>
							<ErrorLine error={error} />
							{!fixedSession && (
								<label className="field">
									<span>session</span>
									<select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
										<option value="">choose a session…</option>
										{sessions.map((s) => (
											<option key={s.id} value={s.id}>
												{s.label}
											</option>
										))}
									</select>
								</label>
							)}
							{sessionId && (
								<div className="field col">
									<div className="row">
										<span className="eyebrow">where to freeze · click a {showAll ? "row" : "user message"}</span>
										<span className="grow" />
										<label className="row tiny">
											<input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
											show every entry (mid-turn checkpoints)
										</label>
									</div>
									<p className="tiny muted" style={{ margin: 0 }}>
										Freezing at a user message replays that message as the prompt. Freezing at any other entry keeps it and asks the agent to continue.
									</p>
									<TimelineRows rows={visible} selected={anchor} onPick={(r) => setAnchor(r.id)} empty="Loading the session…" />
								</div>
							)}
							<label className="field">
								<span>title (optional; the helper suggests one)</span>
								<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
							</label>
							<label className="field">
								<span>desired trajectory: what should have happened instead</span>
								<textarea className="textarea" rows={4} value={desired} onChange={(e) => setDesired(e.target.value)} placeholder="e.g. before choosing a concept, study ad breakdowns from reputable sources on YouTube, Whop and Skool, and license music instead of leaving it out" />
							</label>
							<label className="row small">
								<input type="checkbox" checked={noDraft} onChange={(e) => setNoDraft(e.target.checked)} />
								skip the LLM draft of goal and final state (write them myself)
							</label>
						</>
					)}
				</div>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button type="button" className="btn" onClick={onClose}>
						{done ? "Close" : "Cancel"}
					</button>
					{!done && (
						<button type="button" className="btn btn--primary" disabled={!sessionId || !anchor || busy} onClick={() => void submit()}>
							{busy ? "Capturing…" : "Capture"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
