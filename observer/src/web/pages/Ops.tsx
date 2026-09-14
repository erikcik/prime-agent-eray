import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog, Eyebrow, ErrorLine, KV } from "../components/common.tsx";
import { api } from "../lib/api.ts";
import { ageSeconds, bytes, dateTime, duration } from "../lib/format.ts";
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
	const [confirm, setConfirm] = useState<"restart" | "shutdown" | "deploy" | "model" | "modelStop" | undefined>();
	const [busy, setBusy] = useState(false);
	const [lastDeploy, setLastDeploy] = useState<Awaited<ReturnType<typeof api.deployLast>>>();
	const [pod, setPod] = useState<Awaited<ReturnType<typeof api.modelPod>>>();
	const [bind, setBind] = useState<Awaited<ReturnType<typeof api.binding>>>();
	// Age is rebased on the local clock at every response, so the counter can tick between polls
	// without trusting the Mac's clock to agree with the pod's.
	const bindFetchedAt = useRef(Date.now());
	const [, setBindTick] = useState(0);

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

	// A cold model pod pulls ~19.5 GB before it answers, so the card polls rather than relying on
	// the deploy call to return a finished state. Faster while it is still coming up.
	const loadPod = useCallback(async () => {
		try {
			setPod(await api.modelPod());
		} catch {
			// leave the last known state on screen; the next tick retries
		}
	}, []);

	// Self-scheduling rather than setInterval, and the phase is read from a ref rather than from the
	// dependency array. Putting `pod` in the deps of an effect that also sets `pod` re-runs the
	// effect on every response, which fires the next request immediately instead of after the
	// interval — an unbounded request storm against both the observer and the RunPod API.
	const podRef = useRef(pod);
	podRef.current = pod;
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (cancelled) return;
			await loadPod();
			const p = podRef.current?.phase;
			const settling = p === "starting" || p === "downloading";
			timer = setTimeout(tick, settling ? 5_000 : 20_000);
		};
		void tick();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [loadPod]);

	// The binding lives on Eray's Mac, which the observer cannot reach, so the heartbeat is the only
	// evidence it has. Polling once a minute against a 30 s heartbeat means a binding that dies is
	// on screen as "stale" within roughly two missed beats.
	const loadBinding = useCallback(async () => {
		try {
			const b = await api.binding();
			bindFetchedAt.current = Date.now();
			setBind(b);
		} catch {
			// Keep the last known state: the age below keeps climbing regardless, so a binding that
			// really has stopped still turns stale rather than freezing on a reassuring "healthy".
		}
	}, []);

	useEffect(() => {
		void loadBinding();
		const poll = setInterval(() => void loadBinding(), 60_000);
		const tick = setInterval(() => setBindTick((n) => n + 1), 1000);
		return () => {
			clearInterval(poll);
			clearInterval(tick);
		};
	}, [loadBinding]);

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

	async function run(action: "start" | "restart" | "shutdown" | "deploy" | "model" | "modelStop") {
		setConfirm(undefined);
		setBusy(true);
		setError(undefined);
		try {
			if (action === "start") await api.daemonStart();
			if (action === "restart") await api.daemonRestart();
			if (action === "shutdown") await api.daemonShutdown();
			if (action === "deploy") await api.deploy();
			if (action === "model") setPod(await api.modelPodDeploy());
			if (action === "modelStop") setPod(await api.modelPodStop());
			if (action !== "model" && action !== "modelStop") {
				await refreshHealth();
				await loadLog();
			}
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	}

	// Age is the server's number plus however long we have been holding the response, which needs no
	// agreement between the Mac's clock and the pod's.
	const bindAge = bind?.ageSec === undefined ? undefined : bind.ageSec + Math.floor((Date.now() - bindFetchedAt.current) / 1000);
	const bindPhase = bind ? (bindAge !== undefined && bindAge > bind.staleAfterSec ? "stale" : bind.phase) : undefined;
	const bindPill = bindPhase === "healthy" ? "pill--ink" : bindPhase === "stale" || bindPhase === "failing" ? "pill--fail" : bindPhase === "syncing" ? "pill--live" : "";
	const hb = bind?.heartbeat;

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
				<section className="card">
					<header className="card__head">
						<Eyebrow ink>local model</Eyebrow>
						<span className={`pill ${pod?.phase === "ready" ? "pill--ink" : pod?.phase === "error" ? "pill--fail" : pod?.phase && pod.phase !== "absent" && pod.phase !== "stopped" ? "pill--live" : ""}`}>{pod?.phase ?? "…"}</span>
					</header>
					<div className="card__body col" style={{ gap: 10 }}>
						<KV k="model" v={pod?.servedModel ?? "qwen3.8-27b-abliterated"} mono />
						<KV k="thinking" v="always on (xhigh)" mono />
						<KV k="pod" v={pod?.podId ?? "—"} mono />
						<KV k="gpu" v={pod?.gpu ?? "—"} mono />
						<KV k="cost" v={pod?.costPerHr ? `$${pod.costPerHr}/hr while running` : "—"} mono />
						{pod?.note && <div className="mono tiny muted">{pod.note}</div>}
						{/* The deploy script reports one candidate per line; pre-wrap keeps that readable
						    instead of collapsing four attempts into one dense paragraph. */}
						{pod?.lastError && <div className="mono tiny err" style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>{pod.lastError}</div>}
						<div className="row wrap">
							<button type="button" className="btn btn--accent btn--small" disabled={busy || pod?.phase === "ready" || pod?.phase === "downloading" || pod?.phase === "starting"} onClick={() => setConfirm("model")}>
								{pod?.phase === "stopped" ? "Start model" : "Deploy model"}
							</button>
							<button type="button" className="btn btn--small btn--danger" disabled={busy || !pod?.podId || pod?.phase === "stopped"} onClick={() => setConfirm("modelStop")}>
								Stop model
							</button>
						</div>
					</div>
				</section>
				<section className="card">
					<header className="card__head">
						<Eyebrow ink>folder binding</Eyebrow>
						<span className={`pill ${bindPill}`}>{bindPhase ?? "…"}</span>
					</header>
					<div className="card__body col" style={{ gap: 10 }}>
						<KV k="mac folder" v={hb?.dest ?? "—"} mono />
						<KV k="pod path" v={hb?.remote ?? "/workspace"} mono />
						<KV k="over ssh" v={hb?.host ? `${hb.host}:${hb.port ?? "?"}` : "—"} mono />
						<KV k="last heartbeat" v={ageSeconds(bindAge)} mono />
						<KV k="last sync" v={hb?.lastSyncAt ? `${dateTime(hb.lastSyncAt)} · ${duration(hb.lastSyncDurationMs)}` : "—"} mono />
						<KV k="local copy" v={hb?.localBytes !== undefined ? `${bytes(hb.localBytes)} · ${hb.localFiles ?? "?"} files` : "—"} mono />
						<KV k="last transfer" v={hb?.bytesTransferred !== undefined ? `${bytes(hb.bytesTransferred)} · ${hb.filesTransferred ?? 0} files` : "—"} mono />
						{!!hb?.consecutiveFailures && <KV k="failed passes" v={hb.consecutiveFailures} mono />}
						{bindPhase === "unbound" && (
							<div className="mono tiny muted">
								No binding daemon has ever reported here. Start it on the Mac with <code>deploy/pod-bind.py --install</code>.
							</div>
						)}
						{bindPhase === "stale" && (
							<div className="mono tiny err">
								Nothing heard for over {bind?.staleAfterSec ?? 120}s. The Mac may be asleep or offline, or the binding daemon has stopped — the local folder is no longer tracking the volume.
							</div>
						)}
						{hb?.error && (
							<div className="mono tiny err" style={{ whiteSpace: "pre-wrap", maxHeight: 140, overflowY: "auto" }}>
								{hb.error}
							</div>
						)}
						<div className="mono tiny muted">Pull-only: the pod writes, the Mac folder follows. Nothing local is ever pushed up or deleted.</div>
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
			{confirm === "model" && (
				<ConfirmDialog
					title={pod?.phase === "stopped" ? "Start the model pod" : "Deploy the model pod"}
					body={
						<p>
							{pod?.phase === "stopped"
								? "Restarts the stopped GPU pod. The weights are already cached on the network volume, so this is a warm boot of a few minutes."
								: "Creates a GPU pod in EU-RO-1 on the existing network volume and serves Qwen3.8-27B abliterated with thinking always on. First boot downloads ~19.5 GB."}{" "}
							It bills by the hour for as long as it runs — stop it when you are done.
						</p>
					}
					confirmLabel={pod?.phase === "stopped" ? "Start it" : "Deploy it"}
					onConfirm={() => void run("model")}
					onCancel={() => setConfirm(undefined)}
				/>
			)}
			{confirm === "modelStop" && (
				<ConfirmDialog
					title="Stop the model pod"
					body={
						<p>
							Ends GPU billing by terminating the pod. The 19.5 GB of weights stay on the network volume, so deploying again is still a warm boot &mdash; and terminating avoids a pod being
							stranded on a host whose GPU another tenant has taken. Any agent using this model will start failing until it is back.
						</p>
					}
					confirmLabel="Stop it"
					danger
					onConfirm={() => void run("modelStop")}
					onCancel={() => setConfirm(undefined)}
				/>
			)}
			{confirm === "deploy" && <ConfirmDialog title="Redeploy" body={<p>Pull the latest commit, rebuild what changed, and restart the observer. The harness daemon is only restarted when packages/ changed.</p>} confirmLabel="Redeploy now" danger onConfirm={() => void run("deploy")} onCancel={() => setConfirm(undefined)} />}
		</>
	);
}
