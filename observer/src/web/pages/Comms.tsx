import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentMessageRecord } from "../../shared/comms.ts";
import { Eyebrow, EmptyState, ErrorLine, MonoId } from "../components/common.tsx";
import { api } from "../lib/api.ts";
import { clock, dateTime } from "../lib/format.ts";
import { socket } from "../lib/ws.ts";
import { fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

export function CommsPage() {
	const fleet = useStore(fleetStore);
	const [records, setRecords] = useState<AgentMessageRecord[]>([]);
	const [filter, setFilter] = useState("");
	const [error, setError] = useState<unknown>();
	const [drawer, setDrawer] = useState(false);

	const load = useCallback(async () => {
		try {
			const r = await api.comms(undefined, 500);
			setRecords(r.records);
			setError(undefined);
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void load();
		const off = socket.subscribe("comms", (m) => {
			if (m.t === "comms.message") setRecords((prev) => [m.record, ...prev].slice(0, 1000));
		});
		return off;
	}, [load]);

	const names = useMemo(() => {
		const map = new Map<string, string>();
		const walk = (l: NonNullable<typeof fleet>["roots"]) => {
			for (const n of l) {
				map.set(n.sessionId, n.name ?? n.firstMessage?.slice(0, 40) ?? n.sessionId.slice(0, 8));
				if (n.activeSessionId) map.set(n.activeSessionId, map.get(n.sessionId) ?? n.sessionId.slice(0, 8));
				walk(n.children);
			}
		};
		if (fleet) walk(fleet.roots);
		return map;
	}, [fleet]);

	const shown = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return records;
		return records.filter((r) => `${r.text} ${r.from.sessionName ?? ""} ${r.to.sessionName ?? ""} ${r.relationship ?? ""} ${r.ownerSessionId}`.toLowerCase().includes(q));
	}, [records, filter]);

	const label = (ep: AgentMessageRecord["from"]) => ep.sessionName ?? (ep.sessionId && names.get(ep.sessionId)) ?? (ep.activeSessionId && names.get(ep.activeSessionId)) ?? ep.sessionId?.slice(0, 8) ?? ep.runtimeKind ?? "?";
	const link = (ep: AgentMessageRecord["from"]) => (ep.activeSessionId ?? ep.sessionId ? `/sessions/${encodeURIComponent(ep.activeSessionId ?? ep.sessionId ?? "")}` : undefined);

	return (
		<>
			<div className="page-head">
				<div>
					<Eyebrow>comms</Eyebrow>
					<h1>Agent-to-agent messages</h1>
					<p>Every message exchanged between parents, children and siblings, from transcripts and live events.</p>
				</div>
				<div className="row">
					<input className="input" style={{ width: 260 }} placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
					<button type="button" className="btn" onClick={() => setDrawer(true)}>
						Send message
					</button>
				</div>
			</div>
			<ErrorLine error={error} />
			{shown.length === 0 ? (
				<EmptyState title="No agent messages yet">Messages appear when a child replies to its parent or agents message each other.</EmptyState>
			) : (
				<div className="card card__body">
					{shown.map((r) => {
						const fl = link(r.from);
						const tl = link(r.to);
						return (
							<div key={`${r.id}-${r.ownerSessionId}-${r.direction}`} className="comms-row">
								<span className="mono tiny muted" title={dateTime(r.at)}>
									{clock(r.at)}
								</span>
								<span className="truncate small">
									{fl ? <Link to={fl}>{label(r.from)}</Link> : label(r.from)} {r.relationship && <span className="mono tiny muted">{r.relationship}</span>}
								</span>
								<span className="arrow">→</span>
								<span className="truncate small">{tl ? <Link to={tl}>{label(r.to)}</Link> : label(r.to)}</span>
								<span className="comms-row__text">{r.text}</span>
								<span className="mono tiny muted">
									{r.direction} · <MonoId id={r.ownerSessionId} n={6} copy={false} />
								</span>
							</div>
						);
					})}
				</div>
			)}
			{drawer && <SendDrawer onClose={() => setDrawer(false)} />}
		</>
	);
}

function SendDrawer({ onClose }: { onClose: () => void }) {
	const fleet = useStore(fleetStore);
	const live = useMemo(() => {
		const out: Array<{ id: string; label: string }> = [];
		const walk = (l: NonNullable<typeof fleet>["roots"]) => {
			for (const n of l) {
				if (n.activeSessionId) out.push({ id: n.activeSessionId, label: `${n.name ?? n.firstMessage?.slice(0, 40) ?? n.sessionId.slice(0, 8)} (${n.runtimeKind})` });
				walk(n.children);
			}
		};
		if (fleet) walk(fleet.roots);
		return out;
	}, [fleet]);
	const [from, setFrom] = useState(live[0]?.id ?? "");
	const [to, setTo] = useState(live[1]?.id ?? live[0]?.id ?? "");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>();

	async function send(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			await api.sendAgentMessage(to, text, from);
			onClose();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal" onClick={onClose} role="presentation">
			<form className="modal__card" onClick={(e) => e.stopPropagation()} onSubmit={send}>
				<Eyebrow ink>send agent message</Eyebrow>
				<p className="small muted">The daemon only routes messages within a family (parent, children, siblings).</p>
				<label className="field">
					<span>from (live session)</span>
					<select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
						{live.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>to (live session)</span>
					<select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
						{live.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>message</span>
					<textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} required />
				</label>
				<ErrorLine error={error} />
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn btn--primary" disabled={busy || !from || !to || !text.trim()}>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}
