import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { daemonStore, deployStore, fleetStore, socketStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";
import { ConfirmDialog } from "./common.tsx";

const NAV: Array<[string, string]> = [
	["/signal", "signal"],
	["/lineage", "lineage"],
	["/comms", "comms"],
	["/harness", "harness"],
	["/schedules", "schedules"],
	["/ops", "ops"],
];

export function TopBar() {
	const daemon = useStore(daemonStore);
	const sock = useStore(socketStore);
	const deploy = useStore(deployStore);
	const fleet = useStore(fleetStore);
	const navigate = useNavigate();
	const [confirm, setConfirm] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const daemonState = daemon?.state ?? "offline";
	const daemonClass = daemonState === "online" ? "" : daemonState === "stale" ? "pill--fail" : "pill--live";
	const sockClass = sock === "open" ? "" : sock === "closed" ? "pill--fail" : "pill--live";
	const running = fleet?.counts.running ?? 0;

	async function redeploy() {
		setConfirm(false);
		setError(undefined);
		try {
			await api.deploy();
			navigate("/ops");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	return (
		<header className="topbar">
			<div className="topbar__brand mono">
				prime <span className="muted">·</span> observer
			</div>
			<nav className="topbar__nav">
				{NAV.map(([to, label]) => (
					<NavLink key={to} to={to} className={({ isActive }) => `topbar__link${isActive ? " is-active" : ""}`}>
						{label}
					</NavLink>
				))}
			</nav>
			<div className="topbar__status">
				{running > 0 && (
					<span className="pill pill--live" title="agents working">
						<span className="dot dot--running" />
						{running} live
					</span>
				)}
				<span className={`pill ${daemonClass}`} title={daemon?.socketPath}>
					daemon {daemonState}
				</span>
				<span className={`pill ${sockClass}`} title="observer socket">
					{sock === "open" ? "socket live" : sock}
				</span>
				<button type="button" className={`btn btn--accent btn--small${deploy.running ? " is-busy" : ""}`} onClick={() => setConfirm(true)} disabled={deploy.running} title="Pull the latest code, rebuild, restart the observer">
					<RefreshCw size={12} className={deploy.running ? "spin" : ""} />
					{deploy.running ? "deploying…" : "Redeploy"}
				</button>
			</div>
			{error && <div className="topbar__error banner">{error}</div>}
			{confirm && (
				<ConfirmDialog
					title="Redeploy"
					body={
						<p>
							Pull the latest commit, install dependencies if needed, rebuild, and restart the observer. Running agents are only interrupted when the harness code itself changed (the deploy log will say so).
						</p>
					}
					confirmLabel="Redeploy now"
					danger
					onConfirm={() => void redeploy()}
					onCancel={() => setConfirm(false)}
				/>
			)}
		</header>
	);
}
