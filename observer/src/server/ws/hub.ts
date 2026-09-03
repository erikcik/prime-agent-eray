import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { type ClientMessage, type ServerMessage, type Topic, WS_PROTOCOL, isSessionTopic } from "../../shared/ws.ts";
import { bearerFromWsProtocols, originAllowed, tokensEqual } from "../auth.ts";
import { logger } from "../log.ts";

interface Conn {
	ws: WebSocket;
	topics: Set<Topic>;
	authed: boolean;
	alive: boolean;
	sessionUnsubs: Map<string, () => void>;
	/** Session ids with an attach in flight, so a sub/unsub/sub burst yields exactly one stream. */
	pendingSubs: Set<string>;
}

export interface HubOptions {
	token: string | undefined;
	insecureLocal: boolean;
	allowedOrigins: Set<string>;
	serverStartedAt: string;
	version: string;
	/** Called when a client subscribes to a session topic; returns an unsubscribe. */
	subscribeSession: (activeSessionId: string, send: (msg: ServerMessage) => void) => Promise<() => void>;
	/** Called when a topic gains its first subscriber (e.g. to push a current snapshot). */
	onFirstSubscribe?: (topic: Topic, send: (msg: ServerMessage) => void) => void;
}

const MAX_BUFFERED = 4 * 1024 * 1024;
const PING_MS = 25_000;

/** WebSocket fan-out hub with bearer auth (subprotocol or first frame) and origin allow-list. */
export class Hub {
	private wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false) });
	private conns = new Set<Conn>();
	private log = logger("ws");
	private pingTimer: NodeJS.Timeout;

	constructor(private readonly opts: HubOptions) {
		this.pingTimer = setInterval(() => this.pingAll(), PING_MS);
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const origin = req.headers.origin;
		if (origin && !originAllowed(origin, this.opts.allowedOrigins)) {
			this.log.warn(`rejecting WS from origin ${origin}`);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		if ((req.url ?? "").includes("token=")) {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const presented = bearerFromWsProtocols(req.headers["sec-websocket-protocol"]);
		const preAuthed = !this.opts.token ? this.opts.insecureLocal : tokensEqual(presented, this.opts.token);
		this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, preAuthed));
	}

	private accept(ws: WebSocket, preAuthed: boolean): void {
		const conn: Conn = { ws, topics: new Set(), authed: preAuthed, alive: true, sessionUnsubs: new Map(), pendingSubs: new Set() };
		this.conns.add(conn);
		const authTimer = preAuthed
			? undefined
			: setTimeout(() => {
					if (!conn.authed) ws.close(4401, "auth required");
				}, 5000);
		ws.on("pong", () => {
			conn.alive = true;
		});
		ws.on("message", (data) => {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(data.toString()) as ClientMessage;
			} catch {
				this.send(conn, { t: "error", message: "invalid JSON" });
				return;
			}
			if (!conn.authed) {
				if (msg.t === "auth" && this.opts.token && tokensEqual(msg.token, this.opts.token)) {
					conn.authed = true;
					if (authTimer) clearTimeout(authTimer);
					this.send(conn, { t: "hello", serverStartedAt: this.opts.serverStartedAt, version: this.opts.version });
				} else {
					ws.close(4401, "unauthorized");
				}
				return;
			}
			void this.handleMessage(conn, msg);
		});
		ws.on("close", () => {
			if (authTimer) clearTimeout(authTimer);
			for (const off of conn.sessionUnsubs.values()) off();
			this.conns.delete(conn);
		});
		ws.on("error", (e) => this.log.debug("ws error", e));
		if (preAuthed) this.send(conn, { t: "hello", serverStartedAt: this.opts.serverStartedAt, version: this.opts.version });
	}

	private async handleMessage(conn: Conn, msg: ClientMessage): Promise<void> {
		switch (msg.t) {
			case "ping":
				this.send(conn, { t: "pong" });
				break;
			case "sub":
				for (const topic of msg.topics ?? []) {
					if (conn.topics.has(topic)) continue;
					conn.topics.add(topic);
					const send = (m: ServerMessage) => this.send(conn, m);
					if (isSessionTopic(topic)) {
						const id = topic.slice("session:".length);
						if (conn.sessionUnsubs.has(id) || conn.pendingSubs.has(id)) continue;
						conn.pendingSubs.add(id);
						try {
							const off = await this.opts.subscribeSession(id, send);
							conn.pendingSubs.delete(id);
							if (conn.topics.has(topic) && !conn.sessionUnsubs.has(id)) conn.sessionUnsubs.set(id, off);
							else off();
						} catch (e) {
							conn.pendingSubs.delete(id);
							conn.topics.delete(topic);
							this.send(conn, { t: "error", message: e instanceof Error ? e.message : String(e), code: "session_attach_failed" });
						}
					} else {
						this.opts.onFirstSubscribe?.(topic, send);
					}
				}
				break;
			case "unsub":
				for (const topic of msg.topics ?? []) {
					conn.topics.delete(topic);
					if (isSessionTopic(topic)) {
						const id = topic.slice("session:".length);
						conn.sessionUnsubs.get(id)?.();
						conn.sessionUnsubs.delete(id);
					}
				}
				break;
			default:
				break;
		}
	}

	/** Broadcast to every authed connection subscribed to `topic`. */
	publish(topic: Topic, msg: ServerMessage): void {
		for (const c of this.conns) if (c.authed && c.topics.has(topic)) this.send(c, msg);
	}

	private send(conn: Conn, msg: ServerMessage): void {
		if (conn.ws.readyState !== WebSocket.OPEN) return;
		if (conn.ws.bufferedAmount > MAX_BUFFERED) {
			if (msg.t === "session.event") {
				const id = msg.activeSessionId;
				this.sendRaw(conn, { t: "session.resync_required", activeSessionId: id });
				return;
			}
		}
		this.sendRaw(conn, msg);
	}

	private sendRaw(conn: Conn, msg: ServerMessage): void {
		try {
			conn.ws.send(JSON.stringify(msg));
		} catch (e) {
			this.log.debug("send failed", e);
		}
	}

	private pingAll(): void {
		for (const c of [...this.conns]) {
			if (!c.alive) {
				c.ws.terminate();
				this.conns.delete(c);
				continue;
			}
			c.alive = false;
			try {
				c.ws.ping();
			} catch {
				// ignore
			}
		}
	}

	subscriberCount(topic: Topic): number {
		let n = 0;
		for (const c of this.conns) if (c.topics.has(topic)) n++;
		return n;
	}

	closeAll(code = 1012, reason = "restarting"): void {
		clearInterval(this.pingTimer);
		for (const c of [...this.conns]) {
			try {
				c.ws.close(code, reason);
			} catch {
				// ignore
			}
		}
	}
}
