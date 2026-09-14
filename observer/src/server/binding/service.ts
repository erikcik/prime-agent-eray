import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BindingHeartbeat, BindingStatus } from "../../shared/api.ts";
import { logger } from "../log.ts";

/** How often deploy/pod-bind.py promises to check in. */
export const BINDING_HEARTBEAT_SEC = 30;
/**
 * A binding with no heartbeat for this long is reported stale.
 *
 * Four missed beats rather than one: the Mac sleeps, wifi drops, and a single late POST is not a
 * broken binding. Two minutes is also the outer edge of the cadence the UI polls at, so "stale"
 * appears on screen within one poll of actually being true.
 */
export const BINDING_STALE_SEC = 120;

interface BindingRecord {
	heartbeat: BindingHeartbeat;
	receivedAt: string;
}

export interface BindingServiceOptions {
	dataDir: string;
}

function str(v: unknown, max = 512): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Keep only fields we understand, with the types we expect.
 *
 * The heartbeat arrives from a script on Eray's Mac, not from this codebase, so a version skew
 * between the two is normal and must not be able to write junk into the status the UI renders.
 */
function normalize(input: unknown): BindingHeartbeat {
	const b = (input ?? {}) as Record<string, unknown>;
	const activity = b.activity === "syncing" ? "syncing" : "idle";
	const lastResult = b.lastResult === "ok" || b.lastResult === "error" ? b.lastResult : undefined;
	return {
		dest: str(b.dest) ?? "(unknown)",
		remote: str(b.remote) ?? "/workspace",
		host: str(b.host, 128),
		port: num(b.port),
		podId: str(b.podId, 64),
		activity,
		lastResult,
		lastSyncAt: str(b.lastSyncAt, 64),
		lastSyncDurationMs: num(b.lastSyncDurationMs),
		filesTransferred: num(b.filesTransferred),
		bytesTransferred: num(b.bytesTransferred),
		localBytes: num(b.localBytes),
		localFiles: num(b.localFiles),
		consecutiveFailures: num(b.consecutiveFailures) ?? 0,
		// Long rsync stderr is the norm on failure; keep enough to diagnose, not enough to flood.
		error: str(b.error, 1200),
		daemonStartedAt: str(b.daemonStartedAt, 64),
		agent: str(b.agent, 64),
	};
}

/**
 * Tracks the folder binding between the pod's /workspace volume and the one folder on Eray's Mac.
 *
 * The observer runs on the pod and cannot see the Mac's filesystem, so it cannot check the binding
 * itself. Instead the Mac's binding daemon reports in on a fixed cadence and this service turns
 * "when did we last hear from it" into a phase the UI can render. That inverts the usual direction
 * — the thing being monitored does the calling — which is the only arrangement that works when the
 * monitored side sits behind a home NAT with no inbound route.
 *
 * Silence is therefore meaningful: no heartbeat is the signal that the binding is broken, whether
 * the daemon died, the Mac slept, or the pod's sshd stopped answering.
 */
export class BindingService {
	private log = logger("binding");
	private record: BindingRecord | undefined;
	private loaded = false;
	private beats = 0;

	constructor(private readonly opts: BindingServiceOptions) {}

	private get statePath(): string {
		return join(this.opts.dataDir, "binding.json");
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			this.record = JSON.parse(await readFile(this.statePath, "utf8")) as BindingRecord;
		} catch {
			this.record = undefined;
		}
	}

	/**
	 * Persisting the last heartbeat matters because a Redeploy restarts this process. Without it an
	 * observer restart would show "unbound" for up to a full heartbeat interval even though the
	 * binding never stopped working, and that false alarm is exactly what this panel exists to rule out.
	 */
	private async save(): Promise<void> {
		if (!this.record) return;
		await mkdir(this.opts.dataDir, { recursive: true });
		await writeFile(this.statePath, `${JSON.stringify(this.record, null, 2)}\n`);
	}

	async accept(input: unknown): Promise<BindingStatus> {
		await this.load();
		const heartbeat = normalize(input);
		this.record = { heartbeat, receivedAt: new Date().toISOString() };
		this.beats++;
		try {
			await this.save();
		} catch (e) {
			// A heartbeat that cannot be persisted is still a valid heartbeat; the in-memory record
			// carries the status until the next write succeeds.
			this.log.warn(`could not persist the binding heartbeat: ${(e as Error).message}`);
		}
		return this.statusFrom(this.record);
	}

	async status(): Promise<BindingStatus> {
		await this.load();
		return this.statusFrom(this.record);
	}

	private statusFrom(record: BindingRecord | undefined): BindingStatus {
		const base = {
			staleAfterSec: BINDING_STALE_SEC,
			expectedHeartbeatSec: BINDING_HEARTBEAT_SEC,
			beats: this.beats,
		};
		if (!record) return { ...base, phase: "unbound" };
		const ageSec = Math.max(0, Math.round((Date.now() - Date.parse(record.receivedAt)) / 1000));
		const hb = record.heartbeat;
		const common = { ...base, ageSec, lastHeartbeatAt: record.receivedAt, heartbeat: hb };
		// Staleness outranks everything the heartbeat itself claims: an old "ok" describes a world
		// that stopped being observed two minutes ago, and reporting it as healthy is the one
		// failure this panel must never have.
		if (ageSec > BINDING_STALE_SEC) return { ...common, phase: "stale" };
		if (hb.lastResult === "error") return { ...common, phase: "failing" };
		if (hb.activity === "syncing") return { ...common, phase: "syncing" };
		if (!hb.lastResult) return { ...common, phase: "syncing" };
		return { ...common, phase: "healthy" };
	}
}
