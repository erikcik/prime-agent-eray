import type { DaemonInfo, FleetTree } from "../../shared/fleet.ts";
import type { ServerMessage } from "../../shared/ws.ts";
import { api } from "../lib/api.ts";
import { type SocketStatus, socket } from "../lib/ws.ts";
import { Store } from "./store.ts";

export const daemonStore = new Store<DaemonInfo | undefined>(undefined);
export const fleetStore = new Store<FleetTree | undefined>(undefined);
export const socketStore = new Store<SocketStatus>("idle");
export const deployStore = new Store<{ running: boolean; runId?: string; lines: string[]; exitCode?: number; willRestart?: boolean }>({ running: false, lines: [] });
export const versionStore = new Store<{ observer: string; harness: string; serverStartedAt: string } | undefined>(undefined);

let wired = false;

/** Called once after login: connect the socket and keep the global stores fed. */
export function wireGlobalState(): void {
	if (wired) return;
	wired = true;
	socket.onStatus((s) => socketStore.set(s));
	socket.subscribe("daemon", (m) => {
		if (m.t === "daemon.state") daemonStore.set(m.daemon);
	});
	socket.subscribe("fleet", (m) => {
		if (m.t === "fleet.snapshot") fleetStore.set(m.tree);
	});
	socket.subscribe("deploy", (m: ServerMessage) => {
		if (m.t === "deploy.started") deployStore.set({ running: true, runId: m.runId, lines: [] });
		else if (m.t === "deploy.log") deployStore.set((p) => ({ ...p, lines: [...p.lines.slice(-2000), `${m.stream === "err" ? "! " : ""}${m.line}`] }));
		else if (m.t === "deploy.done") deployStore.set((p) => ({ ...p, running: false, exitCode: m.exitCode, willRestart: m.willRestart }));
	});
	socket.connect();
	void refreshHealth();
	void api.fleet().then((t) => fleetStore.set(t)).catch(() => undefined);
}

export async function refreshHealth(): Promise<void> {
	try {
		const h = await api.health();
		daemonStore.set(h.daemon);
		versionStore.set({ observer: h.version.observer, harness: h.version.harness, serverStartedAt: h.serverStartedAt });
		if (h.deploy?.running) deployStore.set((p) => ({ ...p, running: true, runId: h.deploy?.runId }));
	} catch {
		// server unreachable; socket status will show it
	}
}
