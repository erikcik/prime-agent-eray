import { diffLines } from "diff";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import type { HarnessEntry, HarnessEntryKind, HarnessView, RefinementResult, SkillDoc, SkillSummary } from "../../shared/harness.ts";
import { ConfirmDialog, Eyebrow, EmptyState, ErrorLine, Json, KV, MonoId } from "../components/common.tsx";
import { api } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { socket } from "../lib/ws.ts";
import { fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

const KINDS: HarnessEntryKind[] = ["prompt", "memory", "skill", "subagent"];

export function HarnessPage() {
	const fleet = useStore(fleetStore);
	const [scope, setScope] = useState<string>(""); // "" = global only, else sessionId
	const sessions = useMemo(() => {
		const out: Array<{ id: string; label: string }> = [];
		const walk = (l: NonNullable<typeof fleet>["roots"]) => {
			for (const n of l) {
				out.push({ id: n.sessionId, label: `${n.name ?? n.firstMessage?.slice(0, 40) ?? n.sessionId.slice(0, 8)}${n.activeSessionId ? " · live" : ""}` });
				walk(n.children);
			}
		};
		if (fleet) walk(fleet.roots);
		return out;
	}, [fleet]);

	return (
		<>
			<div className="page-head">
				<div>
					<Eyebrow>continual harness</Eyebrow>
					<h1>What the harness has learned</h1>
					<p>Supplemental prompts, memories, skill descriptions and subagent specs written by /refine, with the history to roll them back.</p>
				</div>
				<div className="row">
					<label className="field">
						<span>scope</span>
						<select className="select" value={scope} onChange={(e) => setScope(e.target.value)} style={{ minWidth: 220 }}>
							<option value="">Global</option>
							{sessions.map((s) => (
								<option key={s.id} value={s.id}>
									{s.label}
								</option>
							))}
						</select>
					</label>
				</div>
			</div>
			<div className="rail__tabs" style={{ marginBottom: 16 }}>
				<NavLink to="/harness" end className={({ isActive }) => `rail__tab${isActive ? " is-active" : ""}`}>
					entries
				</NavLink>
				<NavLink to="/harness/history" className={({ isActive }) => `rail__tab${isActive ? " is-active" : ""}`}>
					refinement history
				</NavLink>
				<NavLink to="/harness/skills" className={({ isActive }) => `rail__tab${isActive ? " is-active" : ""}`}>
					installed skills
				</NavLink>
			</div>
			<Routes>
				<Route index element={<Entries scope={scope} />} />
				<Route path="history" element={<History scope={scope} />} />
				<Route path="skills" element={<Skills />} />
			</Routes>
		</>
	);
}

function useHarness(scope: string) {
	const [view, setView] = useState<HarnessView>();
	const [error, setError] = useState<unknown>();
	const load = useCallback(async () => {
		try {
			setView(await api.harness(scope || undefined));
			setError(undefined);
		} catch (e) {
			setError(e);
		}
	}, [scope]);
	useEffect(() => {
		void load();
		return socket.subscribe("harness", () => void load());
	}, [load]);
	return { view, error, reload: load };
}

function Entries({ scope }: { scope: string }) {
	const { view, error } = useHarness(scope);
	const [kind, setKind] = useState<HarnessEntryKind>("memory");
	const [selected, setSelected] = useState<string>();
	const entries = useMemo(() => (view ? Object.entries(view.merged.entries[kind]).sort((a, b) => (b[1].updated_at ?? "").localeCompare(a[1].updated_at ?? "")) : []), [view, kind]);
	const current = entries.find(([id]) => id === selected)?.[1] ?? entries[0]?.[1];
	const counts = useMemo(() => (view ? Object.fromEntries(KINDS.map((k) => [k, Object.keys(view.merged.entries[k]).length])) : {}), [view]);

	return (
		<>
			<ErrorLine error={error} />
			<div className="seg" style={{ marginBottom: 12 }}>
				{KINDS.map((k) => (
					<button key={k} type="button" className={kind === k ? "is-active" : ""} onClick={() => setKind(k)}>
						{k} {counts[k] !== undefined ? `· ${counts[k]}` : ""}
					</button>
				))}
			</div>
			{view && (
				<div className="mono tiny muted" style={{ marginBottom: 8 }}>
					global: {view.globalDir}
					{view.localDir ? ` · local: ${view.localDir}` : ""}
				</div>
			)}
			<div className="harness">
				<div className="card entry-list">
					{entries.length === 0 && (
						<EmptyState title={`No ${kind} entries`}>Run /refine in a session and the harness will store what it learns here.</EmptyState>
					)}
					{entries.map(([id, e]) => (
						<button key={id} type="button" className={`entry-item${current === e ? " is-active" : ""}`} onClick={() => setSelected(id)}>
							<span className="entry-item__title truncate">{e.title || e.id}</span>
							<span className="entry-item__meta">
								<span>{e.scope}</span>
								<span>v{e.version}</span>
								<span className="truncate">{e.id}</span>
							</span>
						</button>
					))}
				</div>
				<div className="card">{current ? <EntryDetail entry={current} /> : <EmptyState title="Select an entry" />}</div>
			</div>
		</>
	);
}

function EntryDetail({ entry }: { entry: HarnessEntry }) {
	return (
		<div className="card__body col" style={{ gap: 12 }}>
			<div>
				<Eyebrow>{entry.kind}</Eyebrow>
				<h2 style={{ margin: "4px 0 0", fontWeight: 400, fontSize: 18 }}>{entry.title}</h2>
			</div>
			<pre className="codeblock" style={{ fontFamily: "var(--sans)", fontSize: 13 }}>
				{entry.content || "(empty)"}
			</pre>
			<div>
				<KV k="id" v={<MonoId id={entry.id} n={40} />} />
				<KV k="scope" v={entry.scope} mono />
				<KV k="source" v={entry.source} mono />
				<KV k="version" v={entry.version} mono />
				<KV k="path" v={entry.path || "—"} mono />
				<KV k="created" v={dateTime(entry.created_at)} mono />
				<KV k="updated" v={dateTime(entry.updated_at)} mono />
			</div>
			{Object.keys(entry.reference).length > 0 && (
				<div>
					<Eyebrow>reference</Eyebrow>
					<Json value={entry.reference} />
				</div>
			)}
			{Object.keys(entry.arguments).length > 0 && (
				<div>
					<Eyebrow>arguments</Eyebrow>
					<Json value={entry.arguments} />
				</div>
			)}
			{Object.keys(entry.metadata).length > 0 && (
				<div>
					<Eyebrow>metadata</Eyebrow>
					<Json value={entry.metadata} />
				</div>
			)}
		</div>
	);
}

function History({ scope }: { scope: string }) {
	const { view, error, reload } = useHarness(scope);
	const [confirm, setConfirm] = useState<RefinementResult>();
	const [actionError, setActionError] = useState<unknown>();
	const [busy, setBusy] = useState(false);
	const navigate = useNavigate();

	async function rollback(r: RefinementResult) {
		setConfirm(undefined);
		setBusy(true);
		setActionError(undefined);
		try {
			await api.rollback(r.id);
			await reload();
		} catch (e) {
			const err = e as { code?: string; body?: { sessionId?: string } };
			if (err.code === "session_not_live" && err.body?.sessionId) {
				setActionError(new Error(`The owning session is not live. Open it and resume to roll back this local refinement.`));
				navigate(`/sessions/${encodeURIComponent(err.body.sessionId)}`);
			} else setActionError(e);
		} finally {
			setBusy(false);
		}
	}

	const history = view?.history ?? [];
	return (
		<>
			<ErrorLine error={error} />
			<ErrorLine error={actionError} />
			{history.length === 0 ? (
				<EmptyState title="No refinements recorded">Each /refine writes an entry here with before/after diffs.</EmptyState>
			) : (
				<div className="timeline">
					{history.map((r) => (
						<details key={`${r.id}-${r.sourceFile}`} className="timeline__item">
							<summary>
								<div className="row" style={{ justifyContent: "space-between" }}>
									<div className="col" style={{ gap: 2 }}>
										<div className="row">
											<span className={`pill ${r.scope === "local" ? "pill--ghost" : "pill--ink"}`}>{r.scope ?? "global"}</span>
											<strong style={{ fontWeight: 500 }}>{r.summary}</strong>
										</div>
										<div className="mono tiny muted">
											{r.id} · {r.appliedEdits?.length ?? 0} edit{(r.appliedEdits?.length ?? 0) === 1 ? "" : "s"}
											{r.timestamp ? ` · ${dateTime(r.timestamp)}` : ""}
											{r.sessionId ? ` · session ${r.sessionId.slice(0, 8)}` : ""}
											{r.rollbackId ? ` · rollback of ${r.rollbackId}` : ""}
										</div>
									</div>
									<button type="button" className="btn btn--small btn--accent" disabled={busy} onClick={(e) => { e.preventDefault(); setConfirm(r); }}>
										Roll back
									</button>
								</div>
							</summary>
							<div className="col" style={{ gap: 10, marginTop: 12 }}>
								{r.rationale && <KV k="rationale" v={r.rationale} />}
								{r.expectedOutcome && <KV k="expected outcome" v={r.expectedOutcome} />}
								{(r.appliedEdits ?? []).map((edit, i) => (
									<div key={i} className="col" style={{ gap: 6 }}>
										<div className="row">
											<span className="pill pill--ghost">{edit.kind}</span>
											<span className="mono small">{edit.after?.title ?? edit.before?.title ?? edit.id}</span>
											<span className="mono tiny muted">{edit.action ?? (edit.before && edit.after ? "update" : edit.after ? "create" : "delete")}</span>
											{edit.applied === false && <span className="pill pill--fail">not applied</span>}
											{edit.error && <span className="mono tiny" style={{ color: "var(--accent-deep)" }}>{edit.error}</span>}
										</div>
										<EditDiff before={edit.before?.content ?? ""} after={edit.after?.content ?? ""} />
									</div>
								))}
							</div>
						</details>
					))}
				</div>
			)}
			{confirm && (
				<ConfirmDialog
					title="Roll back refinement"
					body={
						<p>
							Undo "<strong>{confirm.summary}</strong>" ({confirm.scope ?? "global"} scope). The daemon records the rollback as a new refinement, so this itself can be undone.
						</p>
					}
					confirmLabel="Roll back"
					danger
					onConfirm={() => void rollback(confirm)}
					onCancel={() => setConfirm(undefined)}
				/>
			)}
		</>
	);
}

export function EditDiff({ before, after }: { before: string; after: string }) {
	const parts = useMemo(() => diffLines(before, after), [before, after]);
	if (!before && !after) return null;
	return (
		<pre className="diff">
			{parts.map((p, i) => (
				<span key={i} className={p.added ? "diff__add" : p.removed ? "diff__del" : ""}>
					{p.value}
				</span>
			))}
		</pre>
	);
}

function Skills() {
	const [skills, setSkills] = useState<SkillSummary[]>([]);
	const [diagnostics, setDiagnostics] = useState<unknown[]>([]);
	const [error, setError] = useState<unknown>();
	const [selected, setSelected] = useState<string>();
	const [doc, setDoc] = useState<SkillDoc>();

	useEffect(() => {
		void api
			.skills()
			.then((r) => {
				setSkills(r.skills);
				setDiagnostics(r.diagnostics);
			})
			.catch(setError);
	}, []);
	useEffect(() => {
		if (!selected) return;
		void api.skillDoc(selected).then(setDoc).catch(setError);
	}, [selected]);

	const html = useMemo(() => (doc ? DOMPurify.sanitize(marked.parse(doc.markdown, { async: false }) as string) : ""), [doc]);

	return (
		<>
			<ErrorLine error={error} />
			<div className="harness">
				<div className="card" style={{ overflow: "hidden" }}>
					<table className="table table--tight">
						<thead>
							<tr>
								<th>skill</th>
								<th>kind</th>
								<th>source</th>
							</tr>
						</thead>
						<tbody>
							{skills.map((s) => (
								<tr key={s.name} onClick={() => setSelected(s.name)} style={{ cursor: "pointer", background: selected === s.name ? "var(--faint)" : undefined }}>
									<td>
										<div style={{ fontWeight: 500 }}>{s.name}</div>
										<div className="muted small">{s.description}</div>
									</td>
									<td className="mono small">{s.kind}</td>
									<td className="mono small">{s.source}</td>
								</tr>
							))}
							{skills.length === 0 && (
								<tr>
									<td colSpan={3}>
										<EmptyState title="No skills found" />
									</td>
								</tr>
							)}
						</tbody>
					</table>
					{diagnostics.length > 0 && (
						<div className="card__body">
							<Eyebrow>diagnostics</Eyebrow>
							<Json value={diagnostics} />
						</div>
					)}
				</div>
				<div className="card">
					{doc ? (
						<div className="card__body col" style={{ gap: 12 }}>
							<div className="mono tiny muted">{doc.filePath}</div>
							<div className="md" dangerouslySetInnerHTML={{ __html: html }} />
							{doc.pyproject && (
								<div>
									<Eyebrow>pyproject.toml</Eyebrow>
									<pre className="codeblock">{doc.pyproject}</pre>
								</div>
							)}
						</div>
					) : (
						<EmptyState title="Select a skill">SKILL.md renders here, with pyproject for Python-backed skills.</EmptyState>
					)}
				</div>
			</div>
		</>
	);
}
