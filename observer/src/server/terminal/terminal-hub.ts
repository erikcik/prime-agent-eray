import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type IPty, spawn as spawnPty } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { TERM_WS_PROTOCOL, type TermClientMessage, type TermServerMessage } from "../../shared/ws.ts";
import { bearerFromWsProtocols, originAllowed, tokensEqual } from "../auth.ts";
import { logger } from "../log.ts";

/**
 * The real prime-agent terminal, in the browser. Each WebSocket owns one PTY running
 * `prime-agent --resume <session file>`: the TUI attaches to the resident daemon worker when the
 * session is live and resumes it otherwise, exactly as it does from a shell. Closing the socket
 * kills the TUI process only; the worker (and the agent) keep running. Bytes cross the socket
 * untouched, so every TUI behaviour (Esc Esc tree, /tree, /fork, steering, the ipython panes)
 * is the harness's own.
 */
export interface TerminalTarget {
	sessionFile: string;
	cwd?: string;
}

export interface TerminalHubOptions {
	token: string | undefined;
	insecureLocal: boolean;
	allowedOrigins: Set<string>;
	/** Launcher for the TUI, e.g. `prime-agent` or the pod's wrapper script. */
	primeAgentBin: string;
	/** Passed as `--daemon-socket` so the TUI talks to the same daemon the observer watches. */
	daemonSocket: string | undefined;
	agentDir: string;
	fallbackCwd: string;
	/** Resolve a session id (session, active, or key) to the file the TUI should resume. */
	resolveTarget: (sessionId: string) => TerminalTarget | undefined;
	/** Concurrent TUIs; each one is a full interactive process on the host. */
	maxTerminals?: number;
}

interface Conn {
	ws: WebSocket;
	authed: boolean;
	sessionId: string;
	pty: IPty | undefined;
	closed: boolean;
}

const DEFAULT_MAX = 8;
const MAX_BUFFERED = 2 * 1024 * 1024;
const AUTH_GRACE_MS = 5000;

/** Secrets the observer holds that an interactive shell process has no business inheriting. */
const SCRUBBED_ENV = ["PRIME_OBSERVER_TOKEN", "RUNPOD_API_KEY", "RUNPOD_DEPLOY_KEY", "OBSERVER_RUNPOD_KEY", "VLLM_API_KEY"];

export class TerminalHub {
	private wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(TERM_WS_PROTOCOL) ? TERM_WS_PROTOCOL : false) });
	private conns = new Set<Conn>();
	private log = logger("term");

	constructor(private readonly opts: TerminalHubOptions) {}

	get openCount(): number {
		return this.conns.size;
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const origin = req.headers.origin;
		if (origin && !originAllowed(origin, this.opts.allowedOrigins)) {
			this.log.warn(`rejecting terminal WS from origin ${origin}`);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const url = new URL(req.url ?? "/", "http://observer.local");
		if (url.searchParams.has("token") || url.searchParams.has("access_token")) {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const sessionId = url.searchParams.get("session")?.trim();
		if (!sessionId) {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const presented = bearerFromWsProtocols(req.headers["sec-websocket-protocol"]);
		const preAuthed = !this.opts.token ? this.opts.insecureLocal : tokensEqual(presented, this.opts.token);
		this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, sessionId, preAuthed));
	}

	private accept(ws: WebSocket, sessionId: string, preAuthed: boolean): void {
		const conn: Conn = { ws, authed: preAuthed, sessionId, pty: undefined, closed: false };
		this.conns.add(conn);
		const authTimer = preAuthed
			? undefined
			: setTimeout(() => {
					if (!conn.authed) ws.close(4401, "auth required");
				}, AUTH_GRACE_MS);
		ws.on("message", (data, isBinary) => {
			// Keystrokes may arrive as binary frames from some clients; treat them as input.
			if (isBinary) {
				if (conn.authed) conn.pty?.write(data.toString("utf8"));
				return;
			}
			let msg: TermClientMessage;
			try {
				msg = JSON.parse(data.toString()) as TermClientMessage;
			} catch {
				this.send(conn, { t: "error", message: "invalid JSON" });
				return;
			}
			if (!conn.authed) {
				if (msg.t === "auth" && this.opts.token && tokensEqual(msg.token, this.opts.token)) {
					conn.authed = true;
					if (authTimer) clearTimeout(authTimer);
					this.send(conn, { t: "hello" });
				} else {
					ws.close(4401, "unauthorized");
				}
				return;
			}
			this.handle(conn, msg);
		});
		ws.on("close", () => {
			if (authTimer) clearTimeout(authTimer);
			this.dispose(conn);
		});
		ws.on("error", (e) => this.log.debug("terminal ws error", e));
		if (preAuthed) this.send(conn, { t: "hello" });
	}

	private handle(conn: Conn, msg: TermClientMessage): void {
		switch (msg.t) {
			case "open":
				this.open(conn, clampCols(msg.cols), clampRows(msg.rows));
				break;
			case "in":
				if (typeof msg.data === "string") conn.pty?.write(msg.data);
				break;
			case "resize":
				if (conn.pty) {
					try {
						conn.pty.resize(clampCols(msg.cols), clampRows(msg.rows));
					} catch (e) {
						this.log.debug("resize failed", e);
					}
				}
				break;
			default:
				break;
		}
	}

	private open(conn: Conn, cols: number, rows: number): void {
		if (conn.pty) {
			this.send(conn, { t: "error", message: "terminal already open" });
			return;
		}
		if (this.activeCount() >= (this.opts.maxTerminals ?? DEFAULT_MAX)) {
			this.send(conn, { t: "error", message: `too many open terminals (limit ${this.opts.maxTerminals ?? DEFAULT_MAX})`, code: "terminal_limit" });
			conn.ws.close(4429, "terminal limit");
			return;
		}
		const target = this.opts.resolveTarget(conn.sessionId);
		if (!target) {
			this.send(conn, { t: "error", message: `unknown session ${conn.sessionId}`, code: "unknown_session" });
			conn.ws.close(4404, "unknown session");
			return;
		}
		const args = ["--resume", target.sessionFile];
		if (this.opts.daemonSocket) args.push("--daemon-socket", this.opts.daemonSocket);
		const cwd = target.cwd && existsSync(target.cwd) ? target.cwd : this.opts.fallbackCwd;
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SCRUBBED_ENV.includes(k)) env[k] = v;
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";
		env.PRIME_AGENT_CODING_AGENT_DIR = this.opts.agentDir;
		if (!env.LANG) env.LANG = "en_US.UTF-8";
		let pty: IPty;
		try {
			pty = spawnPty(this.opts.primeAgentBin, args, { name: "xterm-256color", cols, rows, cwd, env });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.log.warn(`failed to spawn ${this.opts.primeAgentBin}: ${message}`);
			this.send(conn, { t: "error", message: `failed to start the terminal: ${message}`, code: "spawn_failed" });
			conn.ws.close(4500, "spawn failed");
			return;
		}
		conn.pty = pty;
		this.log.info(`terminal ${pty.pid} -> ${this.opts.primeAgentBin} ${args.join(" ")} (cwd ${cwd})`);
		this.send(conn, { t: "ready", pid: pty.pid, cols, rows });
		let paused = false;
		pty.onData((data) => {
			if (conn.ws.readyState !== WebSocket.OPEN) return;
			conn.ws.send(Buffer.from(data, "utf8"), { binary: true }, () => {
				if (paused && conn.ws.bufferedAmount < MAX_BUFFERED / 4) {
					paused = false;
					pty.resume();
				}
			});
			// A viewer that cannot keep up must not make the TUI process block or the observer buffer
			// without bound: pause the PTY until the socket drains.
			if (!paused && conn.ws.bufferedAmount > MAX_BUFFERED) {
				paused = true;
				pty.pause();
			}
		});
		pty.onExit(({ exitCode, signal }) => {
			this.log.info(`terminal ${pty.pid} exited (code ${exitCode}, signal ${signal ?? 0})`);
			conn.pty = undefined;
			this.send(conn, { t: "exit", code: exitCode, signal: signal ?? undefined });
			if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(1000, "terminal exited");
		});
	}

	private dispose(conn: Conn): void {
		if (conn.closed) return;
		conn.closed = true;
		this.conns.delete(conn);
		const pty = conn.pty;
		conn.pty = undefined;
		if (pty) {
			try {
				pty.kill();
			} catch (e) {
				this.log.debug("kill failed", e);
			}
		}
	}

	private send(conn: Conn, msg: TermServerMessage): void {
		if (conn.ws.readyState !== WebSocket.OPEN) return;
		try {
			conn.ws.send(JSON.stringify(msg));
		} catch (e) {
			this.log.debug("send failed", e);
		}
	}

	activeCount(): number {
		let n = 0;
		for (const c of this.conns) if (c.pty) n++;
		return n;
	}

	closeAll(code = 1012, reason = "restarting"): void {
		for (const c of [...this.conns]) {
			try {
				c.ws.close(code, reason);
			} catch {
				// ignore
			}
			this.dispose(c);
		}
	}
}

function clampCols(n: unknown): number {
	const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 80;
	return Math.min(500, Math.max(20, v));
}

function clampRows(n: unknown): number {
	const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 24;
	return Math.min(200, Math.max(5, v));
}
