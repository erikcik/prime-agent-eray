import { DaemonAgentConnection, type DaemonClient } from "@earendil-works/pi-coding-agent";
import { type Logger, logger } from "../log.ts";
import type { DaemonBridge } from "./bridge.ts";

export interface StreamSnapshot {
	activeSessionId: string;
	state: unknown;
	messages: unknown[];
	streamingMessage?: unknown;
	children: unknown[];
	recap?: string;
	capturedAt: string;
}

export type StreamEvent =
	| { kind: "snapshot"; snapshot: StreamSnapshot }
	| { kind: "event"; event: unknown }
	| { kind: "status"; recap?: string }
	| { kind: "connection"; status: unknown }
	| { kind: "children"; children: unknown[] }
	| { kind: "closed"; reason?: string };

type Listener = (ev: StreamEvent) => void;

const RELEASE_GRACE_MS = 15_000;
const MAX_CACHED_MESSAGES = 2000;

class SessionStream {
	refs = 0;
	private conn: DaemonAgentConnection | undefined;
	private unsubscribe: (() => void) | undefined;
	private listeners = new Set<Listener>();
	private releaseTimer: NodeJS.Timeout | undefined;
	snapshot: StreamSnapshot | undefined;
	private log: Logger;

	constructor(
		readonly activeSessionId: string,
		private readonly onDisposed: () => void,
	) {
		this.log = logger(`stream:${activeSessionId.slice(0, 8)}`);
	}

	async open(client: DaemonClient): Promise<void> {
		const conn = await DaemonAgentConnection.attach(client, this.activeSessionId, {
			closeClientOnDispose: false,
			directTransport: false,
			supportsExtensionUi: false,
			snapshotTimeoutMs: 60_000,
		});
		this.conn = conn;
		this.unsubscribe = conn.subscribe((ev) => this.handle(ev));
		const snap = await conn.getInitialSnapshot();
		let children: unknown[] = snap.children ?? [];
		if (!snap.children) {
			try {
				children = await conn.getRlmChildSnapshots();
			} catch {
				children = [];
			}
		}
		this.snapshot = {
			activeSessionId: this.activeSessionId,
			state: snap.state,
			messages: [...snap.messages],
			streamingMessage: snap.streamingMessage,
			children,
			recap: (snap.state as { recap?: string } | undefined)?.recap,
			capturedAt: new Date().toISOString(),
		};
		this.emit({ kind: "snapshot", snapshot: this.snapshot });
	}

	private handle(ev: { type: string; [k: string]: unknown }): void {
		switch (ev.type) {
			case "session_event": {
				const event = ev.event as { type: string; [k: string]: unknown };
				this.applyToCache(event);
				this.emit({ kind: "event", event });
				break;
			}
			case "session_replaced": {
				if (this.snapshot) {
					this.snapshot = {
						...this.snapshot,
						state: ev.state,
						messages: [...(ev.messages as unknown[])],
						streamingMessage: undefined,
						capturedAt: new Date().toISOString(),
					};
					this.emit({ kind: "snapshot", snapshot: this.snapshot });
				}
				break;
			}
			case "session_resynced": {
				const snap = ev.snapshot as { state: unknown; messages: unknown[]; streamingMessage?: unknown; children?: unknown[] };
				this.snapshot = {
					activeSessionId: this.activeSessionId,
					state: snap.state,
					messages: [...snap.messages],
					streamingMessage: snap.streamingMessage,
					children: snap.children ?? this.snapshot?.children ?? [],
					recap: (snap.state as { recap?: string } | undefined)?.recap,
					capturedAt: new Date().toISOString(),
				};
				this.emit({ kind: "snapshot", snapshot: this.snapshot });
				break;
			}
			case "session_status":
				if (this.snapshot) this.snapshot.recap = ev.recap as string | undefined;
				this.emit({ kind: "status", recap: ev.recap as string | undefined });
				break;
			case "connection_status":
				this.emit({ kind: "connection", status: { status: ev.status, error: ev.error } });
				break;
			case "closed":
				this.emit({ kind: "closed", reason: ev.error as string | undefined });
				this.dispose();
				break;
			default:
				break;
		}
	}

	private applyToCache(event: { type: string; [k: string]: unknown }): void {
		const snap = this.snapshot;
		if (!snap) return;
		switch (event.type) {
			case "message_start":
				snap.streamingMessage = event.message;
				break;
			case "message_update":
				snap.streamingMessage = event.message ?? snap.streamingMessage;
				break;
			case "message_end":
				snap.streamingMessage = undefined;
				if (event.message) {
					snap.messages.push(event.message);
					if (snap.messages.length > MAX_CACHED_MESSAGES) snap.messages.splice(0, snap.messages.length - MAX_CACHED_MESSAGES);
				}
				break;
			case "rlm_child_update": {
				const child = event.child as { id: string };
				const idx = snap.children.findIndex((c) => (c as { id: string }).id === child.id);
				if (idx === -1) snap.children.push(child);
				else snap.children[idx] = child;
				this.emit({ kind: "children", children: snap.children });
				break;
			}
			case "recap_update":
				snap.recap = event.recap as string | undefined;
				break;
			default:
				break;
		}
	}

	/** Replace the cached transcript after a server-initiated change (a rewind) and fan it out. */
	replace(state: unknown, messages: unknown[]): void {
		if (!this.snapshot) return;
		this.snapshot = { ...this.snapshot, state, messages: [...messages], streamingMessage: undefined, recap: (state as { recap?: string } | undefined)?.recap ?? this.snapshot.recap, capturedAt: new Date().toISOString() };
		this.emit({ kind: "snapshot", snapshot: this.snapshot });
	}

	subscribe(listener: Listener): () => void {
		this.refs++;
		this.listeners.add(listener);
		if (this.releaseTimer) {
			clearTimeout(this.releaseTimer);
			this.releaseTimer = undefined;
		}
		return () => {
			this.listeners.delete(listener);
			this.refs = Math.max(0, this.refs - 1);
			if (this.refs === 0 && !this.releaseTimer) {
				this.releaseTimer = setTimeout(() => this.dispose(), RELEASE_GRACE_MS);
			}
		};
	}

	private emit(ev: StreamEvent): void {
		for (const l of [...this.listeners]) {
			try {
				l(ev);
			} catch (e) {
				this.log.warn("listener threw", e);
			}
		}
	}

	dispose(): void {
		if (this.releaseTimer) clearTimeout(this.releaseTimer);
		this.releaseTimer = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const conn = this.conn;
		this.conn = undefined;
		if (conn) void conn.dispose().catch(() => undefined);
		this.listeners.clear();
		this.onDisposed();
	}
}

/**
 * Refcounted read-only attachments to live sessions, fanned out to any number of listeners.
 * Never sends client env (watcher semantics), never owns the session.
 */
export class SessionStreamer {
	private streams = new Map<string, SessionStream>();
	private opening = new Map<string, Promise<SessionStream>>();
	private log = logger("streamer");

	constructor(private readonly bridge: DaemonBridge) {
		bridge.subscribe({
			onDisconnected: () => {
				for (const s of [...this.streams.values()]) {
					s.dispose();
				}
				this.streams.clear();
			},
		});
	}

	async subscribe(activeSessionId: string, listener: Listener): Promise<() => void> {
		const stream = await this.acquire(activeSessionId);
		const off = stream.subscribe(listener);
		if (stream.snapshot) listener({ kind: "snapshot", snapshot: stream.snapshot });
		return off;
	}

	cached(activeSessionId: string): StreamSnapshot | undefined {
		return this.streams.get(activeSessionId)?.snapshot;
	}

	private async acquire(activeSessionId: string): Promise<SessionStream> {
		const existing = this.streams.get(activeSessionId);
		if (existing) return existing;
		const pending = this.opening.get(activeSessionId);
		if (pending) return pending;
		const client = this.bridge.requireClient();
		const stream = new SessionStream(activeSessionId, () => this.streams.delete(activeSessionId));
		const p = stream
			.open(client)
			.then(() => {
				this.streams.set(activeSessionId, stream);
				return stream;
			})
			.catch((e) => {
				this.log.warn(`attach failed for ${activeSessionId}`, e);
				throw e;
			})
			.finally(() => this.opening.delete(activeSessionId));
		this.opening.set(activeSessionId, p);
		return p;
	}

	/** Push a fresh transcript to every viewer of a session; a no-op when nobody is watching. */
	replace(activeSessionId: string, state: unknown, messages: unknown[]): void {
		this.streams.get(activeSessionId)?.replace(state, messages);
	}

	activeIds(): string[] {
		return [...this.streams.keys()];
	}
}
