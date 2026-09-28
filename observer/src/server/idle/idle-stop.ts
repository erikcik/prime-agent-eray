import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../log.ts";

export interface IdleStatus {
	enabled: boolean;
	idleMinutes: number;
	/** Reasons the pod counted as busy on the last check; empty while idle. */
	busy: string[];
	lastBusyAt: string;
	lastCheckAt?: string;
	/** When the pod will be stopped if nothing becomes busy before then. */
	stopAt?: string;
	stopping: boolean;
	lastError?: string;
}

export interface IdleStopOptions {
	idleMinutes: number;
	dataDir: string;
	/** Busy reasons right now. Throwing counts as busy: the pod is never stopped on uncertainty. */
	probe: () => Promise<string[]>;
	stop: () => Promise<void>;
	now?: () => number;
	intervalMs?: number;
}

/**
 * Stops this pod after `idleMinutes` with no busy signal (working agents, live schedules, attached
 * terminals, bench work). The Mac `prime` command starts it again, so idle time costs nothing.
 */
export class IdleStopService {
	private log = logger("idle");
	private lastBusyAt: number;
	private busy: string[] = [];
	private lastCheckAt: number | undefined;
	private stopping = false;
	private lastError: string | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly now: () => number;

	constructor(private readonly o: IdleStopOptions) {
		this.now = o.now ?? Date.now;
		// Boot counts as activity: whoever started the pod gets a full window to attach.
		this.lastBusyAt = this.now();
	}

	start(): void {
		if (this.timer) return;
		this.log.info(`idle stop armed: ${this.o.idleMinutes} min`);
		this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 60_000);
	}

	stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async tick(): Promise<void> {
		if (this.stopping) return;
		const now = this.now();
		this.lastCheckAt = now;
		try {
			this.busy = await this.o.probe();
		} catch (e) {
			this.busy = [`probe failed: ${e instanceof Error ? e.message : String(e)}`];
		}
		if (this.busy.length > 0) {
			this.lastBusyAt = now;
			return;
		}
		if (now - this.lastBusyAt < this.o.idleMinutes * 60_000) return;
		this.stopping = true;
		const idleSince = new Date(this.lastBusyAt).toISOString();
		this.log.info(`idle since ${idleSince}; stopping the pod`);
		try {
			mkdirSync(this.o.dataDir, { recursive: true });
			writeFileSync(join(this.o.dataDir, "idle-stop.json"), `${JSON.stringify({ stoppedAt: new Date(now).toISOString(), idleSince }, null, 2)}\n`);
			await this.o.stop();
		} catch (e) {
			this.lastError = e instanceof Error ? e.message : String(e);
			this.log.warn(`stop failed: ${this.lastError}`);
			this.stopping = false;
			// Retry after another full window rather than hammering the API every minute.
			this.lastBusyAt = now;
		}
	}

	status(): IdleStatus {
		return {
			enabled: true,
			idleMinutes: this.o.idleMinutes,
			busy: this.busy,
			lastBusyAt: new Date(this.lastBusyAt).toISOString(),
			lastCheckAt: this.lastCheckAt ? new Date(this.lastCheckAt).toISOString() : undefined,
			stopAt: this.busy.length ? undefined : new Date(this.lastBusyAt + this.o.idleMinutes * 60_000).toISOString(),
			stopping: this.stopping,
			lastError: this.lastError,
		};
	}
}

/** RunPod REST v1: stops (not terminates) the pod; the network volume and the proxy URL survive. */
export async function stopRunpodPod(podId: string, apiKey: string): Promise<void> {
	const res = await fetch(`https://rest.runpod.io/v1/pods/${encodeURIComponent(podId)}/stop`, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) throw new Error(`RunPod stop ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
