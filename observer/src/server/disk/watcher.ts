import { type FSWatcher, existsSync, mkdirSync, watch } from "node:fs";
import { logger } from "../log.ts";

export type WatchArea = "sessions" | "artifacts" | "ledger" | "harness" | "skills";

export interface WatchEvent {
	area: WatchArea;
	path: string;
}

/**
 * Debounced recursive fs.watch over the agent dir areas the UI cares about.
 * Node >= 20 supports recursive watching on both macOS and Linux.
 */
export class AgentDirWatcher {
	private watchers: FSWatcher[] = [];
	private listeners = new Set<(events: WatchEvent[]) => void>();
	private pending = new Map<string, WatchEvent>();
	private timer: NodeJS.Timeout | undefined;
	private log = logger("watch");

	constructor(
		private readonly areas: Record<WatchArea, string>,
		private readonly debounceMs = 300,
	) {}

	start(): void {
		for (const [area, dir] of Object.entries(this.areas) as [WatchArea, string][]) {
			try {
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				const w = watch(dir, { recursive: true }, (_event, filename) => {
					const path = filename ? `${dir}/${filename.toString()}` : dir;
					this.pending.set(`${area}:${path}`, { area, path });
					this.schedule();
				});
				w.on("error", (e) => this.log.warn(`watcher error on ${dir}`, e));
				this.watchers.push(w);
			} catch (e) {
				this.log.warn(`cannot watch ${dir}`, e);
			}
		}
	}

	onChange(listener: (events: WatchEvent[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const events = [...this.pending.values()];
			this.pending.clear();
			for (const l of [...this.listeners]) {
				try {
					l(events);
				} catch (e) {
					this.log.warn("watch listener threw", e);
				}
			}
		}, this.debounceMs);
	}

	stop(): void {
		for (const w of this.watchers) w.close();
		this.watchers = [];
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
