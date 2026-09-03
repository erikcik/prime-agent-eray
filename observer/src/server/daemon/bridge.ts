import { DaemonClient, defaultDaemonSocketPath } from "@earendil-works/pi-coding-agent";
import type { DaemonInfo } from "../../shared/fleet.ts";
import { type Logger, logger } from "../log.ts";

type Hello = NonNullable<DaemonClient["hello"]>;

export type BridgeState = DaemonInfo["state"];

export interface BridgeListener {
	onState?(info: DaemonInfo): void;
	onConnected?(client: DaemonClient, hello: Hello): void | Promise<void>;
	onDisconnected?(): void;
}

/**
 * Owns the single DaemonClient for the process and keeps reconnecting forever.
 * It never starts a daemon on its own; that is an explicit user action (see lifecycle.ts).
 */
export class DaemonBridge {
	readonly socketPath: string;
	private client: DaemonClient | undefined;
	private hello: Hello | undefined;
	private state: BridgeState = "offline";
	private lastError: string | undefined;
	private since = new Date().toISOString();
	private listeners = new Set<BridgeListener>();
	private retryTimer: NodeJS.Timeout | undefined;
	private retryDelay = 500;
	private stopped = false;
	private connecting = false;
	private log: Logger;

	constructor(socketPath?: string) {
		this.socketPath = socketPath ?? defaultDaemonSocketPath();
		this.log = logger("daemon");
	}

	info(): DaemonInfo {
		return {
			state: this.state,
			socketPath: this.socketPath,
			appVersion: this.hello?.appVersion,
			protocolVersion: this.hello?.protocol?.version,
			capabilities: this.hello ? [...this.hello.serverCapabilities] : undefined,
			supervisorGeneration: this.hello?.supervisorGeneration ? Number(this.hello.supervisorGeneration) || undefined : undefined,
			pid: this.hello?.supervisorPid,
			lastError: this.lastError,
			since: this.since,
		};
	}

	get current(): DaemonClient | undefined {
		return this.state === "online" || this.state === "stale" ? this.client : undefined;
	}

	get currentHello(): Hello | undefined {
		return this.hello;
	}

	/** Throws a user-facing error when the daemon is not connected. */
	requireClient(): DaemonClient {
		const c = this.current;
		if (!c || !c.isConnected) throw new DaemonOfflineError(this.socketPath);
		return c;
	}

	supports(capability: string): boolean {
		const c = this.current;
		return !!c && c.supportsServerCapability(capability as never);
	}

	subscribe(listener: BridgeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start(): void {
		this.stopped = false;
		void this.tryConnect();
	}

	stop(): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.teardown("offline");
	}

	/** Force an immediate reconnect attempt (e.g. after the user started the daemon). */
	poke(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.retryDelay = 500;
		void this.tryConnect();
	}

	private setState(state: BridgeState, error?: string): void {
		if (state !== this.state) this.since = new Date().toISOString();
		this.state = state;
		this.lastError = error;
		const info = this.info();
		for (const l of [...this.listeners]) {
			try {
				l.onState?.(info);
			} catch (e) {
				this.log.warn("state listener threw", e);
			}
		}
	}

	private async tryConnect(): Promise<void> {
		if (this.stopped || this.connecting) return;
		if (this.client?.isConnected) return;
		this.connecting = true;
		this.setState("connecting");
		const client = new DaemonClient(this.socketPath);
		try {
			await client.connect(3000);
			const hello = await client.waitForHello(5000);
			this.client = client;
			this.hello = hello;
			this.retryDelay = 500;
			client.onClose(() => {
				if (this.client !== client) return;
				this.log.warn("daemon socket closed");
				this.teardown("offline", "daemon socket closed");
				this.scheduleRetry();
			});
			const stale = !client.supportsServerCapability("agent_roster" as never);
			this.setState(stale ? "stale" : "online");
			this.log.info(`connected to daemon ${hello.appVersion ?? "?"} (${stale ? "stale" : "roster ok"})`);
			for (const l of [...this.listeners]) {
				try {
					await l.onConnected?.(client, hello);
				} catch (e) {
					this.log.warn("connect listener threw", e);
				}
			}
		} catch (error) {
			try {
				client.close();
			} catch {
				// ignore
			}
			const msg = error instanceof Error ? error.message : String(error);
			this.log.debug(`connect failed: ${msg}`);
			this.setState("offline", shorten(msg));
			this.scheduleRetry();
		} finally {
			this.connecting = false;
		}
	}

	private teardown(state: BridgeState, error?: string): void {
		const client = this.client;
		this.client = undefined;
		this.hello = undefined;
		if (client) {
			try {
				client.close();
			} catch {
				// ignore
			}
		}
		this.setState(state, error);
		for (const l of [...this.listeners]) {
			try {
				l.onDisconnected?.();
			} catch (e) {
				this.log.warn("disconnect listener threw", e);
			}
		}
	}

	private scheduleRetry(): void {
		if (this.stopped || this.retryTimer) return;
		const delay = this.retryDelay;
		this.retryDelay = Math.min(this.retryDelay * 2, 5000);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.tryConnect();
		}, delay);
	}
}

export class DaemonOfflineError extends Error {
	readonly code = "daemon_offline";
	constructor(socketPath: string) {
		super(`Prime Agent daemon is not running (socket ${socketPath}).`);
	}
}

function shorten(msg: string): string {
	const first = msg.split("\n")[0] ?? msg;
	return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}
