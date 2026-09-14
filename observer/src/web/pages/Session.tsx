import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SessionDetail } from "../../shared/api.ts";
import type { HarnessView } from "../../shared/harness.ts";
import type { ServerMessage } from "../../shared/ws.ts";
import { ConfirmDialog, Eyebrow, EmptyState, ErrorLine, Json, KV, MonoId, StatusPill, TimeAgo } from "../components/common.tsx";
import { SessionTerminal } from "../components/Terminal.tsx";
import { api, openAuthenticated } from "../lib/api.ts";
import { modelShort, tokens, usd } from "../lib/format.ts";
import { socket } from "../lib/ws.ts";
import { fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

type Msg = Record<string, unknown>;

/** What the right rail needs from the live stream; the transcript itself is the TUI's. */
interface LiveState {
	streaming: boolean;
	children: unknown[];
	recap?: string;
	state?: Record<string, unknown>;
	connection?: string;
	closed?: string;
	/** Bumps when a message lands so the stats panel refetches. */
	landed: number;
}

const EMPTY_LIVE: LiveState = { streaming: false, children: [], landed: 0 };

export function SessionPage() {
	const { id = "" } = useParams();
	const fleet = useStore(fleetStore);
	const [detail, setDetail] = useState<SessionDetail>();
	const [error, setError] = useState<unknown>();
	const [live, setLive] = useState<LiveState>(EMPTY_LIVE);
	const [tab, setTab] = useState<"stats" | "children" | "queue" | "schedules" | "harness" | "goal">("stats");
	const [confirm, setConfirm] = useState<"abort" | "kill" | undefined>();
	const [reconnectKey, setReconnectKey] = useState(0);

	const node = useMemo(() => {
		if (!fleet) return undefined;
		const all: NonNullable<typeof fleet>["roots"] = [];
		const walk = (l: NonNullable<typeof fleet>["roots"]) => {
			for (const n of l) {
				all.push(n);
				walk(n.children);
			}
		};
		walk(fleet.roots);
		return all.find((n) => n.activeSessionId === id) ?? all.find((n) => n.sessionId === id) ?? all.find((n) => n.key === id);
	}, [fleet, id]);
	const activeId = node?.activeSessionId;

	const loadDetail = useCallback(async () => {
		try {
			setDetail(await api.session(id));
			setError(undefined);
		} catch (e) {
			setError(e);
		}
	}, [id]);

	useEffect(() => {
		void loadDetail();
	}, [loadDetail, activeId]);

	// Live stream, kept only for the rail (stats, children, goal, recap). Messages are not
	// accumulated here: the terminal shows the transcript the way the harness renders it.
	useEffect(() => {
		if (!activeId) return;
		setLive(EMPTY_LIVE);
		return socket.subscribe(`session:${activeId}`, (m: ServerMessage) => {
			switch (m.t) {
				case "session.snapshot": {
					const s = m.snapshot as { streamingMessage?: Msg; children: unknown[]; recap?: string; state?: Record<string, unknown> };
					setLive((prev) => ({ ...prev, streaming: !!s.streamingMessage, children: s.children, recap: s.recap, state: s.state }));
					break;
				}
				case "session.event":
					setLive((prev) => applyEvent(prev, m.event as Msg));
					break;
				case "session.status":
					setLive((prev) => ({ ...prev, recap: m.recap as string | undefined }));
					break;
				case "session.children":
					setLive((prev) => ({ ...prev, children: m.children }));
					break;
				case "session.connection":
					setLive((prev) => ({ ...prev, connection: (m.status as { status?: string })?.status }));
					break;
				case "session.closed":
					setLive((prev) => ({ ...prev, closed: m.reason ?? "closed" }));
					break;
				case "session.resync_required":
					socket.subscribe(`session:${activeId}`, () => undefined)();
					break;
				default:
					break;
			}
		});
	}, [activeId]);

	async function act(kind: "abort" | "kill") {
		setConfirm(undefined);
		try {
			if (kind === "abort") await api.abort(id);
			else await api.kill(id);
		} catch (e) {
			setError(e);
		}
	}

	async function exportHtml() {
		try {
			const r = await api.exportHtml(id);
			await openAuthenticated(r.downloadPath);
		} catch (e) {
			setError(e);
		}
	}

	const status = node?.status ?? "inactive";
	const isStreaming = live.streaming || node?.isStreaming;
	const stateRec = live.state ?? (detail?.state as Record<string, unknown> | undefined);
	const modelObj = stateRec?.model as { provider?: string; id?: string } | undefined;
	const model = modelObj?.id ? `${modelObj.provider}/${modelObj.id}` : node?.model;
	const hasTranscript = !!node?.sessionFile;

	return (
		<>
			<div className="session-head">
				<div className="session-head__title">
					<StatusPill status={status} />
					<span>{node?.name ?? node?.firstMessage?.slice(0, 80) ?? detail?.node.firstMessage ?? "session"}</span>
					<MonoId id={node?.sessionId ?? id} n={12} />
					{node?.runtimeKind === "subagent" && node.parentKey && (
						<Link className="pill pill--ghost" to={`/sessions/${encodeURIComponent(parentIdFromKey(node.parentKey))}`}>
							↑ parent
						</Link>
					)}
					<div className="row" style={{ marginLeft: "auto" }}>
						{hasTranscript && (
							<button type="button" className="btn btn--small" title="Detach this terminal and attach a fresh one" onClick={() => setReconnectKey((n) => n + 1)}>
								Reattach
							</button>
						)}
						<button type="button" className="btn btn--small" onClick={() => void exportHtml()}>
							Export HTML
						</button>
						{activeId && (
							<>
								<button type="button" className="btn btn--small btn--accent" disabled={!isStreaming} onClick={() => setConfirm("abort")}>
									Abort
								</button>
								<button type="button" className="btn btn--small btn--danger" onClick={() => setConfirm("kill")}>
									Kill
								</button>
							</>
						)}
					</div>
				</div>
				<div className="session-head__meta">
					<span title={model}>{model ?? "—"}</span>
					{stateRec?.thinkingLevel ? <span>thinking {String(stateRec.thinkingLevel)}</span> : null}
					<span className="truncate" style={{ maxWidth: 360 }} title={node?.cwd}>
						{node?.cwd}
					</span>
					{activeId && <span>active {activeId.slice(0, 8)}</span>}
					{live.connection && live.connection !== "connected" && <span style={{ color: "var(--accent-deep)" }}>{live.connection}</span>}
					{live.closed && <span style={{ color: "var(--accent-deep)" }}>stream closed: {live.closed}</span>}
					<span>
						last activity <TimeAgo iso={node?.lastActivityAt} />
					</span>
				</div>
				{(live.recap ?? node?.recap) && <div className="soft small">{live.recap ?? node?.recap}</div>}
			</div>
			<ErrorLine error={error} />
			<div className="inspector">
				<div>
					{hasTranscript ? <SessionTerminal sessionId={node?.sessionId ?? id} reconnectKey={reconnectKey} /> : <EmptyState title="No transcript yet">This session has no file on disk to attach to.</EmptyState>}
					{hasTranscript && (
						<>
							<div className="term-help tiny muted">
								<span>
									<span className="kbd">esc</span> <span className="kbd">esc</span> tree / rewind
								</span>
								<span>
									<span className="kbd">/tree</span> <span className="kbd">/fork</span> <span className="kbd">/usage</span> harness commands
								</span>
								<span>
									<span className="kbd">ctrl</span>+<span className="kbd">c</span> abort turn
								</span>
								<span>Closing this page detaches the terminal; the agent keeps running.</span>
							</div>
							<AttachStrip id={id} />
						</>
					)}
				</div>
				<aside className="rail">
					<div className="rail__tabs">
						{(["stats", "children", "goal", "queue", "schedules", "harness"] as const).map((t) => (
							<button key={t} type="button" className={`rail__tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
								{t}
								{t === "children" && (live.children.length || node?.children.length) ? ` · ${live.children.length || node?.children.length}` : ""}
							</button>
						))}
					</div>
					{tab === "stats" && <StatsPanel id={id} live={!!activeId} streaming={!!isStreaming} refreshKey={live.landed} state={stateRec} node={node} />}
					{tab === "children" && <ChildrenPanel liveChildren={live.children} node={node} />}
					{tab === "goal" && <GoalPanel goal={(stateRec?.goal as Record<string, unknown> | undefined) ?? (detail?.goal as Record<string, unknown> | undefined)} status={detail?.agentStatus} />}
					{tab === "queue" && <Json value={detail?.queue ?? { note: activeId ? "empty" : "not live" }} />}
					{tab === "schedules" && <SchedulesPanel id={id} />}
					{tab === "harness" && <HarnessPanel id={id} />}
				</aside>
			</div>
			{confirm === "abort" && <ConfirmDialog title="Abort turn" body={<p>Stops the current turn. The session stays live.</p>} confirmLabel="Abort" danger onConfirm={() => void act("abort")} onCancel={() => setConfirm(undefined)} />}
			{confirm === "kill" && <ConfirmDialog title="Kill session runtime" body={<p>Stops this agent's worker (and its Python kernel). The transcript stays resumable.</p>} confirmLabel="Kill" danger onConfirm={() => void act("kill")} onCancel={() => setConfirm(undefined)} />}
		</>
	);
}

function parentIdFromKey(key: string): string {
	const file = key.split("#")[0] ?? key;
	return (file.split("/").pop() ?? file).replace(/\.jsonl$/, "");
}

function applyEvent(prev: LiveState, e: Msg): LiveState {
	switch (e.type) {
		case "message_start":
			return { ...prev, streaming: true };
		case "message_end":
			return { ...prev, streaming: false, landed: prev.landed + 1 };
		case "rlm_child_update": {
			const child = e.child as { id: string };
			const idx = prev.children.findIndex((c) => (c as { id: string }).id === child.id);
			const children = [...prev.children];
			if (idx === -1) children.push(child);
			else children[idx] = child;
			return { ...prev, children };
		}
		case "recap_update":
			return { ...prev, recap: e.recap as string | undefined };
		case "goal_update":
			return { ...prev, state: { ...(prev.state ?? {}), goal: e.goal } };
		default:
			return prev;
	}
}

type Attachment = { id: string; name: string; bytes: number; status: "uploading" | "done" | "error"; path?: string; error?: string };

function formatBytesShort(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Files for the agent go to `<cwd>/inbox/` (the upload contract in server/http/uploads.ts) and
 * are announced by cwd-relative path, which you then mention in the terminal like any other path.
 */
function AttachStrip({ id }: { id: string }) {
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);
	const busy = attachments.some((a) => a.status === "uploading");

	async function attachFiles(list: FileList | null) {
		if (!list?.length) return;
		// Sequential, not Promise.all: parallel large uploads starve each other on one uplink.
		for (const file of Array.from(list)) {
			const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			setAttachments((cur) => [...cur, { id: localId, name: file.name, bytes: file.size, status: "uploading" }]);
			try {
				const stored = await api.uploadFile(file, id);
				setAttachments((cur) => cur.map((a) => (a.id === localId ? { ...a, status: "done", path: stored.path, name: stored.name, bytes: stored.bytes } : a)));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				setAttachments((cur) => cur.map((a) => (a.id === localId ? { ...a, status: "error", error: msg.slice(0, 120) } : a)));
			}
		}
	}

	return (
		<div className="attach-row">
			<button type="button" className="btn btn--small attach-button" disabled={busy} onClick={() => fileInput.current?.click()}>
				{busy ? "Uploading…" : "Attach files"}
			</button>
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					void attachFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<span className="tiny muted">Uploads to this session's inbox/; mention the path in the terminal.</span>
			{attachments.length > 0 && (
				<ul className="attach-list" style={{ flexBasis: "100%" }}>
					{attachments.map((a) => (
						<li key={a.id} className={`attach-item attach-${a.status}`}>
							<span className="attach-name" title={a.name}>
								{a.path ?? a.name}
							</span>
							<span className="attach-meta">
								{formatBytesShort(a.bytes)}
								{a.status === "uploading" ? " · uploading…" : a.status === "error" ? ` · ${a.error}` : ""}
							</span>
							<button type="button" className="attach-remove" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))}>
								×
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Live stats (daemon SessionStats) and the disk summary name the same numbers differently. */
function normalizeStats(stats: Record<string, unknown> | undefined): { usage?: Record<string, number>; cost?: number; messages?: number; contextUsage?: Record<string, number> } {
	if (!stats) return {};
	const usage = (stats.tokens ?? stats.usage) as Record<string, number> | undefined;
	const rawCost = stats.cost ?? (usage as { cost?: unknown } | undefined)?.cost;
	const cost = typeof rawCost === "number" ? rawCost : typeof (rawCost as { total?: unknown } | undefined)?.total === "number" ? (rawCost as { total: number }).total : undefined;
	const messages = typeof stats.totalMessages === "number" ? stats.totalMessages : typeof stats.messageCount === "number" ? stats.messageCount : undefined;
	return { usage, cost, messages, contextUsage: stats.contextUsage as Record<string, number> | undefined };
}

function StatsPanel({ id, live, streaming, refreshKey, state, node }: { id: string; live: boolean; streaming: boolean; refreshKey: number; state?: Record<string, unknown>; node?: { tokens?: { input: number; output: number; cacheRead: number; total: number; cost?: number }; messageCount: number } }) {
	const [stats, setStats] = useState<Record<string, unknown>>();
	// Refetch whenever a message lands (refreshKey), and keep polling while a turn is running so
	// the counters move with the agent rather than with the next page load.
	useEffect(() => {
		let cancelled = false;
		const refresh = () =>
			api
				.stats(id)
				.then((r) => {
					if (!cancelled) setStats((r.stats ?? undefined) as Record<string, unknown> | undefined);
				})
				.catch(() => undefined);
		void refresh();
		if (!live) return;
		const t = setInterval(() => void refresh(), streaming ? 2500 : 8000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, [id, live, streaming, refreshKey]);
	const norm = normalizeStats(stats);
	const ctx = (norm.contextUsage ?? (state?.contextUsage as Record<string, number> | undefined)) as { tokens?: number; contextWindow?: number; percent?: number } | undefined;
	const rawPct = ctx?.percent ?? (ctx?.tokens && ctx.contextWindow ? (ctx.tokens / ctx.contextWindow) * 100 : undefined);
	// The daemon reports e.g. 1.7257000000000002; show one decimal under 10%, whole numbers above.
	const pct = rawPct === undefined ? undefined : rawPct < 10 ? Math.round(rawPct * 10) / 10 : Math.round(rawPct);
	const usage = norm.usage ?? (node?.tokens as Record<string, number> | undefined);
	const cost = norm.cost ?? node?.tokens?.cost;
	return (
		<div className="card card__body">
			{pct !== undefined && (
				<div style={{ marginBottom: 10 }}>
					<div className="row" style={{ justifyContent: "space-between" }}>
						<Eyebrow>context</Eyebrow>
						<span className="mono tiny">
							{tokens(ctx?.tokens)} / {tokens(ctx?.contextWindow)} · {pct}%
						</span>
					</div>
					<div className={`bar${pct > 80 ? " bar--hot" : ""}`}>
						<span style={{ width: `${Math.min(100, pct)}%` }} />
					</div>
				</div>
			)}
			<KV k="input tokens" v={tokens(usage?.input)} mono />
			<KV k="output tokens" v={tokens(usage?.output)} mono />
			<KV k="cache read" v={tokens(usage?.cacheRead)} mono />
			<KV k="total" v={tokens(usage?.total ?? usage?.totalTokens)} mono />
			<KV k="cost" v={usd(cost)} mono />
			<KV k="messages" v={String(norm.messages ?? node?.messageCount ?? "—")} mono />
			{stats && (
				<details style={{ marginTop: 8 }}>
					<summary className="eyebrow" style={{ cursor: "pointer" }}>
						raw stats
					</summary>
					<Json value={stats} />
				</details>
			)}
		</div>
	);
}

function ChildrenPanel({ liveChildren, node }: { liveChildren: unknown[]; node?: { children: Array<{ key: string; sessionId: string; activeSessionId?: string; name?: string; status: string; model?: string; childId?: string }> } }) {
	const live = liveChildren as Array<{ id: string; sessionName?: string; label?: string; status: string; model?: string; activeSessionId?: string; toolUseCount?: number; tokenCount?: number; recap?: string; durationMs?: number; error?: string }>;
	if (live.length === 0 && (!node || node.children.length === 0)) return <EmptyState title="No subagents">Spawned via rlm(...) from the Python REPL.</EmptyState>;
	return (
		<div className="card">
			{live.map((c) => (
				<div key={c.id} className="card__body" style={{ borderBottom: "var(--hair)" }}>
					<div className="row">
						<StatusPill status={c.status === "running" ? "running" : c.status === "error" ? "failed" : c.status === "done" ? "idle" : c.status} label={c.status} />
						<strong style={{ fontWeight: 500 }} className="truncate">
							{c.sessionName ?? c.label}
						</strong>
					</div>
					<div className="mono tiny muted" style={{ marginTop: 4 }}>
						{c.id} · {modelShort(c.model)} · {c.toolUseCount ?? 0} tools · {tokens(c.tokenCount)}
					</div>
					{c.recap && <div className="small soft" style={{ marginTop: 4 }}>{c.recap}</div>}
					{c.error && <div className="small" style={{ color: "var(--accent-deep)" }}>{c.error}</div>}
					{c.activeSessionId && (
						<Link className="btn btn--small" style={{ marginTop: 6 }} to={`/sessions/${encodeURIComponent(c.activeSessionId)}`}>
							open
						</Link>
					)}
				</div>
			))}
			{live.length === 0 &&
				node?.children.map((c) => (
					<div key={c.key} className="card__body" style={{ borderBottom: "var(--hair)" }}>
						<div className="row">
							<StatusPill status={c.status} />
							<Link to={`/sessions/${encodeURIComponent(c.activeSessionId ?? c.sessionId)}`} className="truncate">
								{c.name ?? c.childId}
							</Link>
						</div>
						<div className="mono tiny muted">{modelShort(c.model)}</div>
					</div>
				))}
		</div>
	);
}

function GoalPanel({ goal, status }: { goal?: Record<string, unknown>; status?: { summary: string; taskState?: string } }) {
	return (
		<div className="card card__body">
			{status && (
				<>
					<KV k="agent status" v={status.summary} />
					<KV k="task state" v={status.taskState ?? "—"} mono />
				</>
			)}
			{goal ? (
				<>
					<KV k="goal" v={String(goal.objective ?? "—")} />
					<KV k="status" v={String(goal.status ?? "—")} mono />
					<KV k="tokens used" v={tokens(goal.tokensUsed as number | undefined)} mono />
					<KV k="continuations" v={String(goal.continuationsUsed ?? 0)} mono />
					{goal.lastReason ? <KV k="last reason" v={String(goal.lastReason)} /> : null}
				</>
			) : (
				<div className="muted small">No persistent goal. Set one with /goal in the session.</div>
			)}
		</div>
	);
}

function SchedulesPanel({ id }: { id: string }) {
	const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
	useEffect(() => {
		void api.sessionSchedules(id).then((r) => setJobs(r.jobs as Record<string, unknown>[])).catch(() => undefined);
	}, [id]);
	if (jobs.length === 0) return <EmptyState title="No schedules" />;
	return (
		<div className="card">
			{jobs.map((j, i) => (
				<div key={String(j.id ?? i)} className="card__body" style={{ borderBottom: "var(--hair)" }}>
					<div className="row">
						<span className="pill pill--ghost">{String(j.source ?? "cron")}</span>
						<span className="mono small">{String(j.schedule ?? "")}</span>
						<span className="mono tiny muted">{String(j.status ?? "")}</span>
					</div>
					<div className="small" style={{ marginTop: 4 }}>{String(j.label ?? j.prompt ?? "")}</div>
				</div>
			))}
		</div>
	);
}

function HarnessPanel({ id }: { id: string }) {
	const [view, setView] = useState<HarnessView>();
	useEffect(() => {
		void api.sessionHarness(id).then(setView).catch(() => undefined);
	}, [id]);
	if (!view) return <EmptyState title="Loading…" />;
	const local = view.local;
	const counts = local ? Object.fromEntries((["prompt", "memory", "skill", "subagent"] as const).map((k) => [k, Object.keys(local.entries[k]).length])) : {};
	return (
		<div className="card card__body">
			<Eyebrow>session-local harness state</Eyebrow>
			{local ? (
				<>
					<KV k="prompt notes" v={String(counts.prompt)} mono />
					<KV k="memories" v={String(counts.memory)} mono />
					<KV k="skill descriptions" v={String(counts.skill)} mono />
					<KV k="subagent specs" v={String(counts.subagent)} mono />
				</>
			) : (
				<div className="muted small">No local harness_state.json for this session.</div>
			)}
			<KV k="refinements (local + global)" v={String(view.history.length)} mono />
			<Link className="btn btn--small" style={{ marginTop: 8 }} to="/harness">
				open harness browser
			</Link>
		</div>
	);
}
