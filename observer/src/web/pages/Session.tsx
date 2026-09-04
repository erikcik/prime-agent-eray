import DOMPurify from "dompurify";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SessionDetail } from "../../shared/api.ts";
import type { HarnessView } from "../../shared/harness.ts";
import type { ServerMessage } from "../../shared/ws.ts";
import { ConfirmDialog, Eyebrow, EmptyState, ErrorLine, Json, KV, MonoId, StatusPill, TimeAgo } from "../components/common.tsx";
import { api, openAuthenticated } from "../lib/api.ts";
import { sendWithRecovery } from "../lib/send.ts";
import { clock, dateTime, modelShort, textOf, tokens, usd } from "../lib/format.ts";
import { socket } from "../lib/ws.ts";
import { fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

type Msg = Record<string, unknown>;

interface LiveState {
	messages: Msg[];
	streaming?: Msg;
	children: unknown[];
	recap?: string;
	state?: Record<string, unknown>;
	connection?: string;
	closed?: string;
}

export function SessionPage() {
	const { id = "" } = useParams();
	const fleet = useStore(fleetStore);
	const [detail, setDetail] = useState<SessionDetail>();
	const [error, setError] = useState<unknown>();
	const [live, setLive] = useState<LiveState>({ messages: [], children: [] });
	const [diskMessages, setDiskMessages] = useState<{ messages: Msg[]; hasMore: boolean; offset: number; total: number }>();
	const [follow, setFollow] = useState(true);
	const [tab, setTab] = useState<"stats" | "children" | "queue" | "schedules" | "harness" | "goal">("stats");
	const [confirm, setConfirm] = useState<"abort" | "kill" | undefined>();
	const bottomRef = useRef<HTMLDivElement>(null);

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

	// Disk transcript when not live (or as the initial page before the snapshot).
	useEffect(() => {
		if (activeId) return;
		void api
			.messages(id, { limit: 200 })
			.then((p) => setDiskMessages({ messages: p.messages as Msg[], hasMore: p.hasMore, offset: p.offset, total: p.total }))
			.catch(setError);
	}, [id, activeId]);

	// Live stream.
	useEffect(() => {
		if (!activeId) return;
		setLive({ messages: [], children: [] });
		return socket.subscribe(`session:${activeId}`, (m: ServerMessage) => {
			switch (m.t) {
				case "session.snapshot": {
					const s = m.snapshot as { messages: Msg[]; streamingMessage?: Msg; children: unknown[]; recap?: string; state?: Record<string, unknown> };
					setLive({ messages: s.messages, streaming: s.streamingMessage, children: s.children, recap: s.recap, state: s.state });
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

	const messages = activeId ? live.messages : (diskMessages?.messages ?? []);
	useEffect(() => {
		if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
	}, [messages.length, live.streaming, follow]);

	async function loadEarlier() {
		if (!diskMessages?.hasMore) return;
		const p = await api.messages(id, { before: diskMessages.offset, limit: 200 });
		setDiskMessages({ messages: [...(p.messages as Msg[]), ...diskMessages.messages], hasMore: p.hasMore, offset: p.offset, total: p.total });
	}

	async function act(kind: "abort" | "kill") {
		setConfirm(undefined);
		try {
			if (kind === "abort") await api.abort(id);
			else await api.kill(id);
		} catch (e) {
			setError(e);
		}
	}

	async function resume() {
		try {
			await api.resumeSession(id);
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
	const isStreaming = !!live.streaming || node?.isStreaming;
	const stateRec = live.state ?? (detail?.state as Record<string, unknown> | undefined);
	const modelObj = stateRec?.model as { provider?: string; id?: string } | undefined;
	const model = modelObj?.id ? `${modelObj.provider}/${modelObj.id}` : node?.model;

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
						{!activeId && node?.sessionFile && (
							<button type="button" className="btn btn--small btn--primary" onClick={() => void resume()}>
								Resume
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
					{!activeId && diskMessages?.hasMore && (
						<button type="button" className="btn btn--small" style={{ marginBottom: 10 }} onClick={() => void loadEarlier()}>
							Load earlier ({diskMessages.offset} more)
						</button>
					)}
					<div className="transcript">
						{messages.length === 0 && !live.streaming && <EmptyState title="No messages yet" />}
						{messages.map((m, i) => (
							<MessageBlock key={i} message={m} />
						))}
						{live.streaming && <MessageBlock message={live.streaming} streaming />}
						<div ref={bottomRef} />
					</div>
					{(activeId || node?.sessionFile) && <Composer id={id} streaming={!!isStreaming} live={!!activeId} follow={follow} setFollow={setFollow} />}
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
					{tab === "stats" && <StatsPanel id={id} live={!!activeId} state={stateRec} node={node} />}
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
			return { ...prev, streaming: e.message as Msg };
		case "message_update":
			return { ...prev, streaming: (e.message as Msg) ?? prev.streaming };
		case "message_end":
			return { ...prev, streaming: undefined, messages: e.message ? [...prev.messages, e.message as Msg] : prev.messages };
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
		case "compaction_start":
		case "compaction_end":
		case "refine_complete":
		case "ipython_sent_agent_message":
			return { ...prev, messages: [...prev.messages, { role: "__marker", marker: e }] };
		default:
			return prev;
	}
}

function MessageBlock({ message, streaming }: { message: Msg; streaming?: boolean }) {
	const role = message.role as string;
	if (role === "__marker") return <Marker event={message.marker as Msg} />;
	if (role === "user") {
		return (
			<div className="msg msg--user">
				<div className="msg__head">
					<Eyebrow ink>user</Eyebrow>
					<Time m={message} />
				</div>
				<div className="md" dangerouslySetInnerHTML={{ __html: md(textOf(message.content)) }} />
			</div>
		);
	}
	if (role === "assistant") {
		const content = Array.isArray(message.content) ? (message.content as Msg[]) : [];
		const usage = message.usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
		return (
			<div className={`msg msg--assistant${streaming ? " msg--streaming" : ""}`}>
				<div className="msg__head">
					<Eyebrow ink>assistant</Eyebrow>
					<span className="mono tiny muted">{modelShort(message.model as string | undefined)}</span>
					{usage && (
						<span className="mono tiny muted">
							{tokens(usage.input)}→{tokens(usage.output)} · {usd(usage.cost?.total)}
						</span>
					)}
					<Time m={message} />
				</div>
				{content.map((part, i) => {
					if (part.type === "thinking") {
						return (
							<details key={i} className="thinking">
								<summary>thinking</summary>
								{String(part.thinking ?? "")}
							</details>
						);
					}
					if (part.type === "text") return <div key={i} className="md" dangerouslySetInnerHTML={{ __html: md(String(part.text ?? "")) }} />;
					if (part.type === "toolCall") {
						const args = part.arguments as Record<string, unknown> | undefined;
						const code = typeof args?.code === "string" ? args.code : JSON.stringify(args, null, 2);
						return (
							<div key={i} className="msg msg--tool" style={{ marginTop: 8 }}>
								<div className="msg__head">
									<Eyebrow ink>{String(part.name ?? "tool")}</Eyebrow>
									<span className="mono tiny muted">{String(part.id ?? "")}</span>
								</div>
								<pre className="codeblock">{code}</pre>
							</div>
						);
					}
					return null;
				})}
			</div>
		);
	}
	if (role === "toolResult") {
		const text = textOf(message.content);
		const isError = message.isError === true;
		const details = message.details as Record<string, unknown> | undefined;
		const images = Array.isArray(message.content) ? (message.content as Msg[]).filter((p) => p.type === "image") : [];
		return (
			<details className="msg msg--tool" open={text.length < 1200}>
				<summary className="msg__head">
					<Eyebrow ink>{String(message.toolName ?? "result")}</Eyebrow>
					<span className={`mono tiny ${isError ? "" : "muted"}`} style={isError ? { color: "var(--accent-deep)" } : undefined}>
						{isError ? "error" : `${text.length} chars`}
					</span>
					<Time m={message} />
				</summary>
				<pre className={`codeblock${isError ? " codeblock--err" : ""}`}>{text || "(no output)"}</pre>
				{images.map((im, i) => (
					<img key={i} alt="tool output" src={`data:${String(im.mimeType ?? "image/png")};base64,${String(im.data ?? "")}`} style={{ maxWidth: "100%", display: "block", borderTop: "var(--hair)" }} />
				))}
				{details && Object.keys(details).length > 0 && (
					<details style={{ padding: "6px 12px", borderTop: "var(--hair)" }}>
						<summary className="eyebrow" style={{ cursor: "pointer" }}>
							details
						</summary>
						<Json value={details} />
					</details>
				)}
			</details>
		);
	}
	if (role === "custom_message" || message.customType) {
		const isAgent = message.customType === "agent_message";
		return (
			<div className={`msg ${isAgent ? "msg--agent" : "msg--marker"}`}>
				<div className="msg__head">
					<Eyebrow ink>{String(message.customType ?? "custom")}</Eyebrow>
					<Time m={message} />
				</div>
				<div className="small" style={{ whiteSpace: "pre-wrap" }}>
					{textOf(message.content)}
				</div>
			</div>
		);
	}
	return (
		<div className="msg msg--marker">
			{String(role)} · <Json value={message} />
		</div>
	);
}

function Marker({ event }: { event: Msg }) {
	const t = String(event.type);
	let text = t;
	if (t === "compaction_start") text = `compaction started (${String(event.reason)})`;
	if (t === "compaction_end") text = `compaction ${event.aborted ? "aborted" : "done"}`;
	if (t === "refine_complete") text = `refine: ${String((event.result as { summary?: string })?.summary ?? "")}`;
	if (t === "ipython_sent_agent_message") {
		const m = event.message as { message?: string; receiver_role?: string; receiver_name?: string };
		text = `→ ${m.receiver_name ?? m.receiver_role ?? "agent"}: ${m.message ?? ""}`;
	}
	return <div className="msg msg--marker">{text}</div>;
}

function Time({ m }: { m: Msg }) {
	const ts = m.timestamp as number | string | undefined;
	return (
		<span className="mono tiny muted" style={{ marginLeft: "auto" }} title={ts ? dateTime(ts) : undefined}>
			{ts ? clock(ts) : ""}
		</span>
	);
}

function md(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

// A Redeploy (git pull -> observer build -> exit 87 -> supervisor restart) was measured at
// 35-60 s on the pod, and a full container restart is slower still. The budget must comfortably
// exceed that or recovery exhausts mid-restart and strands the message, which a 20 s budget did.
const SEND_BUDGET_MS = 120_000;

type Attachment = { id: string; name: string; bytes: number; status: "uploading" | "done" | "error"; path?: string; error?: string };

function formatBytesShort(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * The model only ever sees the message text, so an uploaded file has to be announced there by
 * path — same contract as ai-ceo-1's `taskWithAttachments`.
 */
export function messageWithAttachments(text: string, attachments: Attachment[]): string {
	const done = attachments.filter((a) => a.status === "done" && a.path);
	if (!done.length) return text;
	const lines = done.map((a) => `- ${a.path} (${formatBytesShort(a.bytes)})`);
	return `${text}\n\nAttached files (already uploaded to this session's \`inbox/\` folder; open them with these cwd-relative paths):\n${lines.join("\n")}`;
}

function Composer({ id, streaming, live, follow, setFollow }: { id: string; streaming: boolean; live: boolean; follow: boolean; setFollow: (v: boolean) => void }) {
	const [mode, setMode] = useState<"prompt" | "steer" | "followUp">("prompt");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>();
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);
	const uploading = attachments.some((a) => a.status === "uploading");

	// A restart banner must not outlive the restart. Once the socket is open again the observer is
	// demonstrably back, so a stale "observer is restarting" line is worse than nothing: it claims
	// sending is impossible when pressing Send now works. Only subscribes while such a banner is
	// actually up, and clears with a plain value (never a functional updater — `error` is typed
	// `unknown`, so a function would be ambiguous between "new value" and "updater").
	useEffect(() => {
		if (!error) return;
		const msg = error instanceof Error ? error.message : String(error);
		if (!/observer is restarting|observer unreachable/i.test(msg)) return;
		return socket.onStatus((s) => {
			if (s === "open") setError(undefined);
		});
	}, [error]);

	async function attachFiles(list: FileList | null) {
		if (!list?.length) return;
		// Sequential, not Promise.all: parallel large uploads starve each other on one uplink
		// and make every row look stalled at once.
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

	async function send() {
		const body = messageWithAttachments(text.trim(), attachments);
		if (!body) return;
		setBusy(true);
		setError(undefined);
		try {
			// All restart recovery lives in sendWithRecovery, which is unit-tested against every
			// failure shape seen on the pod: an inactive session after a pod restart (resume then
			// send), the proxy interstitial during a Redeploy (safe to re-send), and an ambiguous
			// 5xx or dropped socket (check the transcript first — re-sending blindly would
			// duplicate the prompt).
			await sendWithRecovery({
				id,
				mode,
				body,
				api,
				budgetMs: SEND_BUDGET_MS,
				onStatus: (m) => setError(new Error(m)),
			});
			setText("");
			setAttachments([]);
			setError(undefined);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="composer">
			<ErrorLine error={error} />
			<div className="row" style={{ justifyContent: "space-between" }}>
				<div className="seg">
					{(["prompt", "steer", "followUp"] as const).map((m) => (
						<button key={m} type="button" className={mode === m ? "is-active" : ""} onClick={() => setMode(m)}>
							{m === "followUp" ? "follow-up" : m}
						</button>
					))}
				</div>
				<label className="row tiny muted">
					<input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> auto-follow
				</label>
			</div>
			<div className="composer__row">
				<textarea
					className="textarea grow"
					placeholder={
						!live
							? "Session is idle — sending will resume it first"
							: mode === "prompt"
								? streaming
									? "Queued until the current turn ends…"
									: "Send a prompt"
								: mode === "steer"
									? "Interrupt with a steering note"
									: "Follow-up after this turn"
					}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
					}}
				/>
				<button type="button" className="btn btn--primary" disabled={busy || uploading || (!text.trim() && !attachments.some((a) => a.status === "done"))} onClick={() => void send()}>
					{uploading ? "Uploading…" : "Send"}
				</button>
			</div>
			<div className="attach-row">
				<button type="button" className="btn btn--small attach-button" disabled={busy} onClick={() => fileInput.current?.click()}>
					Attach files
				</button>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						void attachFiles(e.target.files);
						// Reset so re-picking the same file fires change again.
						e.target.value = "";
					}}
				/>
				<span className="tiny muted">
					{live ? "Uploaded to this session's inbox/ and listed in the message by path." : "Session is idle — sending resumes it first, then delivers your message."}
				</span>
			</div>
			{attachments.length > 0 && (
				<ul className="attach-list">
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
			<div className="tiny muted">⌘/Ctrl+Enter to send.</div>
		</div>
	);
}

function StatsPanel({ id, live, state, node }: { id: string; live: boolean; state?: Record<string, unknown>; node?: { tokens?: { input: number; output: number; cacheRead: number; total: number; cost?: number }; messageCount: number } }) {
	const [stats, setStats] = useState<Record<string, unknown>>();
	useEffect(() => {
		void api
			.stats(id)
			.then((r) => setStats((r.stats ?? undefined) as Record<string, unknown> | undefined))
			.catch(() => undefined);
		if (!live) return;
		const t = setInterval(() => void api.stats(id).then((r) => setStats((r.stats ?? undefined) as Record<string, unknown> | undefined)).catch(() => undefined), 8000);
		return () => clearInterval(t);
	}, [id, live]);
	const ctx = state?.contextUsage as { tokens?: number; contextWindow?: number; percent?: number } | undefined;
	const pct = ctx?.percent ?? (ctx?.tokens && ctx.contextWindow ? Math.round((ctx.tokens / ctx.contextWindow) * 100) : undefined);
	const usage = (stats?.usage as Record<string, number> | undefined) ?? node?.tokens;
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
			<KV k="total" v={tokens((usage as Record<string, number> | undefined)?.total ?? (usage as Record<string, number> | undefined)?.totalTokens)} mono />
			<KV k="cost" v={usd(typeof usage?.cost === "number" ? usage.cost : (usage?.cost as unknown as { total?: number })?.total)} mono />
			<KV k="messages" v={String(stats?.messageCount ?? node?.messageCount ?? "—")} mono />
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
