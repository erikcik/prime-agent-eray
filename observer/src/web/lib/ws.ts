import { type ServerMessage, type Topic, WS_PROTOCOL } from "../../shared/ws.ts";
import { encodeWsBearer, getToken } from "./auth.ts";

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type Listener = (msg: ServerMessage) => void;

/**
 * Single multiplexed WebSocket. Pages subscribe to topics; subscriptions are replayed on reconnect.
 * Auth travels in the subprotocol (falls back to a first `auth` frame if the proxy strips it).
 */
class ObserverSocket {
	private ws: WebSocket | undefined;
	private status: SocketStatus = "idle";
	private statusListeners = new Set<(s: SocketStatus) => void>();
	private topicListeners = new Map<string, Set<Listener>>();
	private anyListeners = new Set<Listener>();
	private retryDelay = 500;
	private retryTimer: number | undefined;
	private wanted = false;
	private pingTimer: number | undefined;
	serverStartedAt: string | undefined;

	getStatus(): SocketStatus {
		return this.status;
	}

	onStatus(fn: (s: SocketStatus) => void): () => void {
		this.statusListeners.add(fn);
		fn(this.status);
		return () => this.statusListeners.delete(fn);
	}

	connect(): void {
		this.wanted = true;
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
		const token = getToken();
		if (!token) return;
		this.setStatus(this.status === "idle" || this.status === "closed" ? "connecting" : "reconnecting");
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${location.host}/ws`, [WS_PROTOCOL, encodeWsBearer(token)]);
		this.ws = ws;
		ws.onopen = () => {
			this.retryDelay = 500;
			// Fallback auth frame in case the proxy dropped the subprotocol; the server ignores it when pre-authed.
			if (!ws.protocol) ws.send(JSON.stringify({ t: "auth", token }));
			const topics = [...this.topicListeners.keys()].filter((t) => (this.topicListeners.get(t)?.size ?? 0) > 0);
			if (topics.length) ws.send(JSON.stringify({ t: "sub", topics }));
			this.setStatus("open");
			this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping" })), 20_000);
		};
		ws.onmessage = (ev) => {
			let msg: ServerMessage;
			try {
				msg = JSON.parse(String(ev.data)) as ServerMessage;
			} catch {
				return;
			}
			if (msg.t === "hello") this.serverStartedAt = msg.serverStartedAt;
			for (const l of this.anyListeners) l(msg);
			const topic = topicOf(msg);
			if (topic) for (const l of this.topicListeners.get(topic) ?? []) l(msg);
		};
		ws.onclose = (ev) => {
			if (this.pingTimer) window.clearInterval(this.pingTimer);
			this.ws = undefined;
			if (ev.code === 4401) {
				this.setStatus("closed");
				return;
			}
			if (!this.wanted) {
				this.setStatus("closed");
				return;
			}
			this.setStatus("reconnecting");
			this.scheduleRetry();
		};
		ws.onerror = () => {
			// onclose follows
		};
	}

	disconnect(): void {
		this.wanted = false;
		if (this.retryTimer) window.clearTimeout(this.retryTimer);
		this.ws?.close(1000, "bye");
		this.ws = undefined;
		this.setStatus("closed");
	}

	private scheduleRetry(): void {
		if (this.retryTimer) return;
		const delay = this.retryDelay;
		this.retryDelay = Math.min(this.retryDelay * 1.8, 8000);
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = undefined;
			this.connect();
		}, delay);
	}

	subscribe(topic: Topic, listener: Listener): () => void {
		let set = this.topicListeners.get(topic);
		const first = !set || set.size === 0;
		if (!set) {
			set = new Set();
			this.topicListeners.set(topic, set);
		}
		set.add(listener);
		if (first && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "sub", topics: [topic] }));
		return () => {
			set?.delete(listener);
			if (set && set.size === 0) {
				this.topicListeners.delete(topic);
				if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "unsub", topics: [topic] }));
			}
		};
	}

	onAny(listener: Listener): () => void {
		this.anyListeners.add(listener);
		return () => this.anyListeners.delete(listener);
	}

	private setStatus(s: SocketStatus): void {
		this.status = s;
		for (const l of this.statusListeners) l(s);
	}
}

function topicOf(msg: ServerMessage): Topic | undefined {
	switch (msg.t) {
		case "daemon.state":
			return "daemon";
		case "fleet.snapshot":
		case "fleet.patch":
			return "fleet";
		case "harness.changed":
			return "harness";
		case "schedules.changed":
			return "schedules";
		case "comms.message":
		case "comms.status":
			return "comms";
		case "deploy.started":
		case "deploy.log":
		case "deploy.done":
			return "deploy";
		case "session.snapshot":
		case "session.event":
		case "session.status":
		case "session.connection":
		case "session.children":
		case "session.closed":
		case "session.resync_required":
			return `session:${msg.activeSessionId}`;
		default:
			return undefined;
	}
}

export const socket = new ObserverSocket();
