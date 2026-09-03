import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentNode } from "../../shared/fleet.ts";
import { Eyebrow, EmptyState, MonoId, StatusPill, TimeAgo } from "../components/common.tsx";
import { modelShort, tokens, usd } from "../lib/format.ts";
import { fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

interface Row {
	node: AgentNode;
	depth: number;
}

export function LineagePage() {
	const fleet = useStore(fleetStore);
	const [showDeleted, setShowDeleted] = useState(false);
	const [onlyFamilies, setOnlyFamilies] = useState(true);
	const navigate = useNavigate();

	const rows = useMemo(() => {
		if (!fleet) return [] as Row[];
		const out: Row[] = [];
		const walk = (list: AgentNode[], depth: number) => {
			for (const n of list) {
				if (!showDeleted && n.status === "deleted") continue;
				if (depth === 0 && onlyFamilies && n.children.length === 0) continue;
				out.push({ node: n, depth });
				walk(n.children, depth + 1);
			}
		};
		walk(fleet.roots, 0);
		return out;
	}, [fleet, showDeleted, onlyFamilies]);

	return (
		<>
			<div className="page-head">
				<div>
					<Eyebrow>lineage</Eyebrow>
					<h1>Who spawned whom</h1>
					<p>The full RLM spawn topology from the daemon roster and the on-disk ledger, including children that no longer exist.</p>
				</div>
				<div className="row">
					<label className="row small">
						<input type="checkbox" checked={onlyFamilies} onChange={(e) => setOnlyFamilies(e.target.checked)} /> only roots with children
					</label>
					<label className="row small">
						<input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> show deleted
					</label>
				</div>
			</div>
			{rows.length === 0 ? (
				<EmptyState title="No lineage to show">No session has spawned a subagent yet{onlyFamilies ? ", or untick the filter to see every root" : ""}.</EmptyState>
			) : (
				<div className="card" style={{ overflowX: "auto" }}>
					<table className="table table--tight">
						<thead>
							<tr>
								<th>agent</th>
								<th>status</th>
								<th>depth</th>
								<th>child id</th>
								<th>model</th>
								<th>msgs</th>
								<th>tokens</th>
								<th>cost</th>
								<th>spawned</th>
								<th>last activity</th>
							</tr>
						</thead>
						<tbody>
							{rows.map(({ node, depth }) => (
								<tr key={node.key} className={`lineage-row${node.status === "deleted" ? " agent-row--deleted" : ""}`} onClick={() => navigate(`/sessions/${encodeURIComponent(node.activeSessionId ?? node.sessionId)}`)} style={{ cursor: "pointer" }}>
									<td>
										<span className="lineage-name">
											{depth > 0 && <span className="depth-guides" style={{ "--d": depth } as React.CSSProperties} />}
											<span className={depth === 0 ? "" : "small"}>{node.name ?? node.firstMessage?.slice(0, 60) ?? node.childId ?? "untitled"}</span>
											<MonoId id={node.sessionId} n={6} />
										</span>
									</td>
									<td>
										<StatusPill status={node.status} />
									</td>
									<td className="mono">{depth}</td>
									<td className="mono small">{node.childId ?? "—"}</td>
									<td className="mono small" title={node.model}>
										{modelShort(node.model)}
									</td>
									<td className="mono">{node.messageCount}</td>
									<td className="mono">{tokens(node.tokens?.total)}</td>
									<td className="mono">{usd(node.tokens?.cost)}</td>
									<td>
										<TimeAgo iso={node.createdAt} />
									</td>
									<td>
										<TimeAgo iso={node.lastActivityAt} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}
