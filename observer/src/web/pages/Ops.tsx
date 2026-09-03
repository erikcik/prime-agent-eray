import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog, Eyebrow, ErrorLine, KV } from "../components/common.tsx";
import { api } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { daemonStore, deployStore, refreshHealth, socketStore, versionStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";

export function OpsPage() {
	const daemon = useStore(daemonStore);
	const sock = useStore(socketStore);
	const version = useStore(versionStore);
	const deploy = useStore(deployStore);
	const [log, setLog] = useState<string[]>([]);
	const [logPath, setLogPath] = useState("");
	const [error, setError] = useState<unknown>();
	const [confirm, setConfirm] = useState<"restart" | "shutdown" | "deploy" | undefined>();
	const [busy, setBusy] = useState(false);
	const [lastDeploy, setLastDeploy] = useState<Awaited<ReturnType<typeof api.deployLast>>>();

	const loadLog = useCallback(async () => {
		try {
			const r = await api.daemonLog(300);
			setLog(r.lines);
			setLogPath(r.path);
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void loadLog();
		void api.deployLast().then(setLastDeploy).catch(() => undefined);
		const t = setInterval(() => void loadLog(), 10_000);
		return () => clearInterval(t);
	}, [loadLog]);

	// After a successful deploy the server exits 87; poll health until it is back, then reload.
	const restartingRef = useRef(false);
	useEffect(() => {
		if (!deploy.willRestart || restartingRef.current) return;
		restartingRef.current = true;
		const startedAt = version?.serverStartedAt;
		let tries = 0;
		const t = setInterval(async () => {
			tries++;
			try {
				const h = await api.health();
				if (h.serverStartedAt !== startedAt) {
					clearInterval(t);
					location.reload();
				}
			} catch {
				// still restarting
			}
			if (tries > 240) clearInterval(t);
		}, 1000);
		return () => clearInterval(t);
	}, [deploy.willRestart, version?.serverStartedAt]);

	async function run(action: "start" | "restart" | "shutdown" | "deploy") {
		setConfirm(undefined);
		setBusy(true);
		setError(undefined);
		try {
			if (action === "start") await api.daemonStart();
			if (action === "restart") await api.daemonRestart();
			if (action === "shutdown") await api.daemonShutdown();
			if (action === "deploy") await api.deploy();
			await refreshHealth();
			await loadLog();
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	}

	const phases = deploy.lines.filter((l) => l.startsWith("::phase ")).map((l) => l.slice(8));

	return (
		<>
			<div className="page-head">
				<div>
					<Eyebrow>ops</Eyebrow>
					<h1>Daemon, versions, deploy</h1>
					<p>The machinery under the agents. Redeploy pulls the latest code and restarts what changed.</p>
				</div>
			</div>
			<ErrorLine error={error} />
			<div className="ops-grid">
				<section className="card">
					<header className="card__head">
						<Eyebrow ink>versions</Eyebrow>
					</header>
					<div className="card__body">
						<KV k="observer" v={version?.observer} mono />
						<KV k="harness (package)" v={version?.harness} mono />
						<KV k="daemon app" v={daemon?.appVersion} mono />
						<KV k="daemon protocol" v={daemon?.protocolVersion} mono />
						<KV k="server started" v={version ? dateTime(version.serverStartedAt) : "—"} mono />
						<KV k="observer socket" v={sock} mono />
					</div>
				</section>
				<section className="card">
					<header className="card__head">
						<Eyebrow ink>daemon</Eyebrow>
						<span className={`pill ${daemon?.state === "online" ? "" : "pill--live"}`}>{daemon?.state ?? "offline"}</span>
					</header>
					<div className="card__body col" style={{ gap: 10 }}>
						<KV k="socket" v={daemon?.socketPath} mono />
						<KV k="pid" v={daemon?.pid} mono />
						<KV k="since" v={daemon?.since ? dateTime(daemon.since) : "—"} mono />
						{daemon?.lastError && <KV k="last error" v={daemon.lastError} mono />}
						<div className="row wrap">
							<button type="button" className="btn btn--small" disabled={busy || daemon?.state === "online"} onClick={() => void run("start")}>
								Start daemon
							</button>
							<button type="button" className="btn btn--small" disabled={busy || daemon?.state === "offline"} onClick={() => setConfirm("restart")}>
								Restart
							</button>
							<button type="button" className="btn btn--small btn--danger" disabled={busy || daemon?.state === "offline"} onClick={() => setConfirm("shutdown")}>
								Shutdown
							</button>
						</div>
						<details>
							<summary className="eyebrow" style={{ cursor: "pointer" }}>
								capabilities ({daemon?.capabilities?.length ?? 0})
							</summary>
							<div className="mono tiny muted" style={{ marginTop: 6, wordBreak: "break-word" }}>
								{daemon?.capabilities?.join(" · ")}
							</div>
						</details>
					</div>
				</section>
				<section className="card" style={{ gridColumn: "1 / -1" }}>
					<header className="card__head">
						<div className="row">
							<Eyebrow ink>deploy console</Eyebrow>
							{deploy.running && <span className="pill pill--live">running</span>}
							{!deploy.running && deploy.exitCode !== undefined && <span className={`pill ${deploy.exitCode === 0 ? "pill--ink" : "pill--fail"}`}>exit {deploy.exitCode}</span>}
							{deploy.willRestart && <span className="pill pill--live">restarting…</span>}
						</div>
						<div className="row">
							<button type="button" className={`btn btn--accent btn--small${deploy.running ? " is-busy" : ""}`} disabled={busy || deploy.running} onClick={() => setConfirm("deploy")}>
								Redeploy
							</button>
						</div>
					</header>
					<div className="card__body col" style={{ gap: 10 }}>
						{phases.length > 0 && (
							<div className="phases">
								{phases.map((p, i) => (
									<span key={`${p}-${i}`} className={`pill ${i === phases.length - 1 && deploy.running ? "pill--live" : "pill--ink"}`}>
										{p}
									</span>
								))}
							</div>
						)}
						<pre className="log">
							{(deploy.lines.length ? deploy.lines : (lastDeploy?.lines ?? ["No deploy has run since this observer started."])).map((l, i) => (
								<div key={i} className={l.startsWith("! ") || l.startsWith("[err]") ? "err" : ""}>
									{l}
								</div>
							))}
						</pre>
						{lastDeploy && !deploy.lines.length && (
							<div className="mono tiny muted">
								last run {lastDeploy.runId} · exit {lastDeploy.exitCode ?? "?"}
							</div>
						)}
					</div>
				</section>
				<section className="card" style={{ gridColumn: "1 / -1" }}>
					<header className="card__head">
						<Eyebrow ink>daemon log</Eyebrow>
						<span className="mono tiny muted truncate" title={logPath}>
							{logPath}
						</span>
					</header>
					<div className="card__body">
						<pre className="log">{log.length ? log.join("\n") : "no log yet"}</pre>
					</div>
				</section>
			</div>
			{confirm === "restart" && <ConfirmDialog title="Restart daemon" body={<p>Restarts the supervisor. Running turns are interrupted; sessions remain resumable.</p>} confirmLabel="Restart" danger onConfirm={() => void run("restart")} onCancel={() => setConfirm(undefined)} />}
			{confirm === "shutdown" && <ConfirmDialog title="Shut down daemon" body={<p>Stops every agent, worker and background service. On the pod the supervisor loop will start it again.</p>} confirmLabel="Shut down" danger onConfirm={() => void run("shutdown")} onCancel={() => setConfirm(undefined)} />}
			{confirm === "deploy" && <ConfirmDialog title="Redeploy" body={<p>Pull the latest commit, rebuild what changed, and restart the observer. The harness daemon is only restarted when packages/ changed.</p>} confirmLabel="Redeploy now" danger onConfirm={() => void run("deploy")} onCancel={() => setConfirm(undefined)} />}
		</>
	);
}
