import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentNode, FleetTree } from "../../shared/fleet.ts";
import type { ServerMessage } from "../../shared/ws.ts";
import { Eyebrow, EmptyState, MonoId, StatusDot, TimeAgo } from "../components/common.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";
import { clock, modelShort, usd } from "../lib/format.ts";
import { socket } from "../lib/ws.ts";
import { daemonStore, fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

export function SignalPage() {
	const fleet = useStore(fleetStore);
	const daemon = useStore(daemonStore);
	const [showNew, setShowNew] = useState(false);
	const navigate = useNavigate();

	return (
		<>
			<div className="page-head">
				<div>
					<Eyebrow>fleet signal</Eyebrow>
					<h1>What the agents are doing</h1>
					<p>Every root agent with its recursive subagents. Accent means alive or waiting on you.</p>
				</div>
				<div className="row">
					<button type="button" className="btn btn--primary" onClick={() => setShowNew(true)} disabled={daemon?.state !== "online"} title={daemon?.state !== "online" ? "daemon offline" : undefined}>
						<Plus size={14} /> New session
					</button>
				</div>
			</div>
			{fleet ? <Counters tree={fleet} /> : null}
			<div className="signal">
				<div className="boards">
					{!fleet && <EmptyState title="Loading fleet…" />}
					{fleet && fleet.roots.length === 0 && (
						<EmptyState title="No sessions yet">
							Start one with <em>New session</em>, or run <code className="code">prime-agent</code> on this host.
						</EmptyState>
					)}
					{fleet?.roots.map((root) => <FamilyBoard key={root.key} node={root} onOpen={(n) => navigate(`/sessions/${encodeURIComponent(n.activeSessionId ?? n.sessionId)}`)} />)}
				</div>
				<LiveTicker tree={fleet} />
			</div>
			{showNew && <NewSessionDialog onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/sessions/${encodeURIComponent(id)}`)} />}
		</>
	);
}

function Counters({ tree }: { tree: FleetTree }) {
	const c = tree.counts;
	const cost = useMemo(() => sumCost(tree.roots), [tree]);
	return (
		<div className="counters">
			<Counter label="running" n={c.running} live={c.running > 0} />
			<Counter label="needs input" n={c.needsInput} live={c.needsInput > 0} />
			<Counter label="idle" n={c.idle} />
			<Counter label="subagents" n={c.subagents} />
			<Counter label="saved" n={c.inactive} />
			<Counter label="failed" n={c.failed} fail={c.failed > 0} />
			<Counter label="spend (disk)" text={usd(cost)} />
		</div>
	);
}

function sumCost(nodes: AgentNode[]): number {
	let t = 0;
	for (const n of nodes) {
		if (n.runtimeKind === "top-level") t += n.tokens?.cost ?? 0;
		t += sumCost(n.children.filter((c) => c.runtimeKind === "top-level"));
	}
	return t;
}

function Counter({ label, n, text, live, fail }: { label: string; n?: number; text?: string; live?: boolean; fail?: boolean }) {
	return (
		<div className={`counter${live ? " counter--live" : ""}${fail ? " counter--fail" : ""}`}>
			<div className="counter__n">{text ?? n}</div>
			<Eyebrow>{label}</Eyebrow>
		</div>
	);
}

export function FamilyBoard({ node, onOpen }: { node: AgentNode; onOpen: (n: AgentNode) => void }) {
	const alive = node.status === "running" || node.status === "needs_input";
	const flat = useMemo(() => flatten(node.children, 1), [node]);
	return (
		<div className={`board${alive ? " board--live" : ""}`}>
			<div className="board__root" onClick={() => onOpen(node)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(node)}>
				<StatusDot status={node.status} />
				<div className="col" style={{ gap: 0 }}>
					<div className="board__title">
						<span className="truncate">{node.name ?? node.firstMessage?.slice(0, 80) ?? "untitled session"}</span>
						<MonoId id={node.sessionId} />
					</div>
					{node.recap && <div className="board__recap truncate">{node.recap}</div>}
				</div>
				<div className="board__meta">
					<span title={node.model}>{modelShort(node.model)}</span>
					<span>{node.messageCount} msgs</span>
					{node.tokens?.cost !== undefined && <span>{usd(node.tokens.cost)}</span>}
					<TimeAgo iso={node.lastActivityAt ?? node.createdAt} />
				</div>
			</div>
			{flat.length > 0 && (
				<div className="board__children">
					{flat.map((c) => (
						<div key={c.key} className={`agent-row${c.status === "deleted" ? " agent-row--deleted" : ""}`} style={{ "--indent": `${(c.depth - 1) * 16}px` } as React.CSSProperties} onClick={() => onOpen(c)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(c)}>
							<span />
							<StatusDot status={c.status} />
							<div className="agent-row__name">
								<span className="tick" />
								<span className="truncate">{c.name ?? c.childId ?? c.sessionId}</span>
								<span className="mono">{modelShort(c.model)}</span>
								{c.recap && <span className="agent-row__recap truncate">{c.recap}</span>}
							</div>
							<div className="board__meta">
								<span>d{c.depth}</span>
								<TimeAgo iso={c.lastActivityAt ?? c.createdAt} />
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function flatten(nodes: AgentNode[], depth: number): AgentNode[] {
	const out: AgentNode[] = [];
	for (const n of nodes) {
		out.push({ ...n, depth });
		out.push(...flatten(n.children, depth + 1));
	}
	return out;
}

interface TickerItem {
	at: string;
	session: string;
	label: string;
	text: string;
}

const MAX_TICKER = 60;
const MAX_HOT = 8;

function LiveTicker({ tree }: { tree: FleetTree | undefined }) {
	const [items, setItems] = useState<TickerItem[]>([]);
	const hot = useMemo(() => {
		if (!tree) return [] as AgentNode[];
		const all: AgentNode[] = [];
		const walk = (l: AgentNode[]) => {
			for (const n of l) {
				all.push(n);
				walk(n.children);
			}
		};
		walk(tree.roots);
		return all.filter((n) => n.activeSessionId && (n.status === "running" || n.status === "needs_input" || n.status === "idle")).slice(0, MAX_HOT);
	}, [tree]);

	const hotKey = hot.map((n) => `${n.activeSessionId}|${n.name ?? n.sessionId}`).join(",");
	useEffect(() => {
		const offs = hot.map((n) =>
			socket.subscribe(`session:${n.activeSessionId}`, (m: ServerMessage) => {
				if (m.t !== "session.event") return;
				const summary = summarizeEvent(m.event);
				if (!summary) return;
				setItems((prev) => [{ at: new Date().toISOString(), session: n.name ?? n.sessionId.slice(0, 8), ...summary }, ...prev].slice(0, MAX_TICKER));
			}),
		);
		return () => {
			for (const off of offs) off();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hotKey]);

	return (
		<aside className="ticker">
			<div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
				<Eyebrow ink>live ticker</Eyebrow>
				<span className="mono tiny muted">{hot.length} watched</span>
			</div>
			<div className="ticker__list">
				{items.length === 0 && <div className="muted small">Tool calls, agent messages, goal and child updates from live sessions appear here.</div>}
				{items.map((it, i) => (
					<div key={`${it.at}-${i}`} className="ticker__item">
						<span className="ticker__time">{clock(it.at)}</span>
						<span className="truncate">
							<span className="ticker__chip">{it.session}</span>
							<span className="muted">{it.label}</span> {it.text}
						</span>
					</div>
				))}
			</div>
		</aside>
	);
}

function summarizeEvent(ev: unknown): { label: string; text: string } | undefined {
	const e = ev as { type?: string; [k: string]: unknown };
	switch (e.type) {
		case "tool_execution_start": {
			const args = e.args as { code?: string } | undefined;
			return { label: String(e.toolName ?? "tool"), text: (args?.code ?? "").split("\n")[0]?.slice(0, 90) ?? "" };
		}
		case "tool_execution_end":
			return { label: "result", text: e.isError ? "error" : "ok" };
		case "rlm_child_update": {
			const c = e.child as { sessionName?: string; status?: string; label?: string };
			return { label: "child", text: `${c.sessionName ?? c.label ?? ""} ${c.status ?? ""}` };
		}
		case "ipython_sent_agent_message": {
			const m = e.message as { message?: string; receiver_name?: string; receiver_role?: string };
			return { label: "msg→", text: `${m.receiver_name ?? m.receiver_role ?? ""}: ${(m.message ?? "").slice(0, 80)}` };
		}
		case "goal_update": {
			const g = e.goal as { status?: string; objective?: string };
			return { label: "goal", text: `${g.status ?? ""} ${g.objective ?? ""}`.slice(0, 90) };
		}
		case "recap_update":
			return { label: "recap", text: String(e.recap ?? "").slice(0, 90) };
		case "turn_end":
			return { label: "turn", text: "ended" };
		case "compaction_start":
			return { label: "compact", text: String(e.reason ?? "") };
		case "refine_complete":
			return { label: "refine", text: String((e.result as { summary?: string })?.summary ?? "").slice(0, 90) };
		case "message_end": {
			const m = e.message as { role?: string; content?: unknown };
			if (m?.role !== "assistant") return undefined;
			const txt = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>).find((p) => p.type === "text")?.text : undefined;
			return txt ? { label: "said", text: txt.slice(0, 90) } : undefined;
		}
		default:
			return undefined;
	}
}
