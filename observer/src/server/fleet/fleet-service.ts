import type { AgentNode, FleetTree } from "../../shared/fleet.ts";
import type { DaemonBridge } from "../daemon/bridge.ts";
import { RosterStore } from "../daemon/roster-store.ts";
import { collectChildSessionFiles } from "../disk/artifacts-reader.ts";
import { type LedgerEdge, readLedgerEdges } from "../disk/ledger-reader.ts";
import type { AgentPaths } from "../disk/paths.ts";
import { type SessionSummaryOnDisk, invalidateSession, listRootSessionFiles, readSession } from "../disk/sessions-reader.ts";
import type { AgentDirWatcher } from "../disk/watcher.ts";
import { logger } from "../log.ts";
import { buildFleetTree, flattenTree } from "./tree-builder.ts";

/**
 * Keeps the FleetTree current: live roster pushes + disk scans (debounced) -> rebuild -> publish.
 * Disk scanning is incremental per file via the sessions-reader memo (mtime+size keyed).
 */
export class FleetService {
	readonly roster: RosterStore;
	private tree: FleetTree;
	private disk = new Map<string, SessionSummaryOnDisk>();
	private edges: LedgerEdge[] = [];
	private listeners = new Set<(tree: FleetTree) => void>();
	private rebuildTimer: NodeJS.Timeout | undefined;
	private scanTimer: NodeJS.Timeout | undefined;
	private scanning: Promise<void> | undefined;
	private log = logger("fleet");

	constructor(
		private readonly bridge: DaemonBridge,
		private readonly paths: AgentPaths,
		watcher: AgentDirWatcher,
	) {
		this.roster = new RosterStore();
		this.tree = buildFleetTree({ roster: [], edges: [], disk: new Map(), live: false });
		this.roster.onUpdate(() => this.scheduleRebuild());
		bridge.subscribe({
			onConnected: async (client) => {
				try {
					await this.roster.attach(client);
				} catch (e) {
					this.log.warn("roster attach failed", e);
				}
				this.scheduleRebuild();
			},
			onDisconnected: () => {
				this.roster.clear();
				this.scheduleRebuild();
			},
		});
		watcher.onChange((events) => {
			let needScan = false;
			for (const ev of events) {
				if (ev.area === "sessions" || ev.area === "artifacts" || ev.area === "ledger") {
					needScan = true;
					if (ev.path.endsWith(".jsonl")) invalidateSession(ev.path);
				}
			}
			if (needScan) this.scheduleScan();
		});
		// Periodic safety net (fs.watch can miss events on some volumes).
		setInterval(() => this.scheduleScan(), 30_000).unref();
	}

	async start(): Promise<void> {
		await this.scan();
		// First build synchronously so the first request after start sees the disk state.
		if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
		this.rebuildTimer = undefined;
		this.rebuild();
	}

	current(): FleetTree {
		return this.tree;
	}

	onTree(listener: (tree: FleetTree) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** All known session JSONL files (roots + children), for comms and harness scans. */
	sessionFiles(): string[] {
		return [...this.disk.keys()];
	}

	diskSummary(sessionFile: string): SessionSummaryOnDisk | undefined {
		return this.disk.get(sessionFile);
	}

	/** Resolve an id that may be an activeSessionId, a sessionId, or a node key. */
	findNode(id: string): AgentNode | undefined {
		const all = flattenTree(this.tree);
		return all.find((n) => n.activeSessionId === id) ?? all.find((n) => n.sessionId === id) ?? all.find((n) => n.key === id);
	}

	allNodes(): AgentNode[] {
		return flattenTree(this.tree);
	}

	scheduleScan(delayMs = 400): void {
		if (this.scanTimer) return;
		this.scanTimer = setTimeout(() => {
			this.scanTimer = undefined;
			void this.scan();
		}, delayMs);
	}

	async scan(): Promise<void> {
		if (this.scanning) return this.scanning;
		this.scanning = (async () => {
			try {
				const [roots, children, edges] = await Promise.all([
					listRootSessionFiles(this.paths.sessionsDir),
					collectChildSessionFiles(this.paths.artifactsRoot),
					readLedgerEdges(this.paths.ledgerDir),
				]);
				const files = new Set([...roots, ...children]);
				const next = new Map<string, SessionSummaryOnDisk>();
				await Promise.all(
					[...files].map(async (file) => {
						try {
							const parsed = await readSession(file);
							next.set(file, parsed.summary);
						} catch (e) {
							this.log.debug(`skip unreadable session ${file}`, e);
						}
					}),
				);
				this.disk = next;
				this.edges = edges;
				this.scheduleRebuild();
			} catch (e) {
				this.log.warn("scan failed", e);
			} finally {
				this.scanning = undefined;
			}
		})();
		return this.scanning;
	}

	private scheduleRebuild(): void {
		if (this.rebuildTimer) return;
		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = undefined;
			this.rebuild();
		}, 150);
	}

	private rebuild(): void {
		const live = this.bridge.current?.isConnected === true;
		this.tree = buildFleetTree({ roster: this.roster.all(), edges: this.edges, disk: this.disk, live });
		for (const l of [...this.listeners]) {
			try {
				l(this.tree);
			} catch (e) {
				this.log.warn("tree listener threw", e);
			}
		}
	}
}
