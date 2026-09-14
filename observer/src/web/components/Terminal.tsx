import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { TERM_WS_PATH, TERM_WS_PROTOCOL, type TermServerMessage } from "../../shared/ws.ts";
import { encodeWsBearer, getToken } from "../lib/auth.ts";

type Phase = "connecting" | "live" | "exited" | "disconnected" | "error";

const FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * The TUI paints its own theme (dark boxes, muted greys) on whatever background the terminal has,
 * so the terminal is always the dark surface a terminal is, in both page themes. Colours mirror
 * the dark token set in styles/tokens.css.
 */
const TERM_THEME = {
	background: "#0f0f0f",
	foreground: "#f0f0f0",
	cursor: "#ff5777",
	cursorAccent: "#0f0f0f",
	selectionBackground: "#52212f",
	selectionForeground: "#f0f0f0",
};

/**
 * The prime-agent TUI itself, attached to this session over a PTY on the observer. Nothing here
 * interprets the session: keystrokes go down, bytes come up. Esc Esc, /tree, /fork, steering and
 * the ipython panes are all the harness's own behaviour.
 */
export function SessionTerminal({ sessionId, reconnectKey }: { sessionId: string; reconnectKey: number }) {
	const host = useRef<HTMLDivElement>(null);
	const [phase, setPhase] = useState<Phase>("connecting");
	const [detail, setDetail] = useState<string>();
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		const el = host.current;
		if (!el) return;
		let disposed = false;
		const term = new XTerm({
			fontFamily: FONT,
			fontSize: 13,
			lineHeight: 1.25,
			letterSpacing: 0,
			scrollback: 10_000,
			cursorBlink: true,
			cursorStyle: "bar",
			allowTransparency: false,
			macOptionIsMeta: true,
			theme: TERM_THEME,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		let ws: WebSocket | undefined;
		let ready = false;
		let resizeTimer: number | undefined;

		const send = (msg: unknown) => {
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};
		const doFit = () => {
			try {
				fit.fit();
			} catch {
				// container not laid out yet
			}
		};

		// Open only once the mono font is available: xterm measures cell size at open and a
		// fallback font would leave the grid misaligned once Geist Mono arrives.
		const fontReady = typeof document.fonts?.load === "function" ? document.fonts.load(`13px ${FONT}`).then(() => undefined, () => undefined) : Promise.resolve();
		void fontReady.then(() => {
			if (disposed) return;
			term.open(el);
			doFit();
			term.focus();
			setPhase("connecting");
			setDetail(undefined);
			const token = getToken();
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const url = `${proto}://${location.host}${TERM_WS_PATH}?session=${encodeURIComponent(sessionId)}`;
			ws = new WebSocket(url, token ? [TERM_WS_PROTOCOL, encodeWsBearer(token)] : [TERM_WS_PROTOCOL]);
			ws.binaryType = "arraybuffer";
			ws.onopen = () => {
				if (token && !ws?.protocol) send({ t: "auth", token });
				doFit();
				send({ t: "open", cols: term.cols, rows: term.rows });
			};
			ws.onmessage = (ev) => {
				if (ev.data instanceof ArrayBuffer) {
					term.write(new Uint8Array(ev.data));
					return;
				}
				let msg: TermServerMessage;
				try {
					msg = JSON.parse(String(ev.data)) as TermServerMessage;
				} catch {
					return;
				}
				if (msg.t === "ready") {
					ready = true;
					setPhase("live");
					// The PTY was created at the size we asked for; a fit in between may have changed it.
					send({ t: "resize", cols: term.cols, rows: term.rows });
				} else if (msg.t === "exit") {
					ready = false;
					setPhase("exited");
					setDetail(msg.code === 0 ? "The terminal session ended." : `The terminal exited with code ${msg.code}.`);
				} else if (msg.t === "error") {
					setPhase("error");
					setDetail(msg.message);
				}
			};
			ws.onclose = (ev) => {
				ws = undefined;
				if (disposed) return;
				setPhase((p) => (p === "exited" || p === "error" ? p : "disconnected"));
				if (ev.code === 4401) setDetail("Not authorised for the terminal socket.");
				else setDetail((d) => d ?? (ev.reason ? `Connection closed: ${ev.reason}` : "Connection closed."));
			};
		});

		const onData = term.onData((data) => {
			if (ready) send({ t: "in", data });
		});
		const onResize = term.onResize(({ cols, rows }) => {
			if (ready) send({ t: "resize", cols, rows });
		});
		const ro = new ResizeObserver(() => {
			if (resizeTimer) window.clearTimeout(resizeTimer);
			resizeTimer = window.setTimeout(doFit, 60);
		});
		ro.observe(el);

		return () => {
			disposed = true;
			if (resizeTimer) window.clearTimeout(resizeTimer);
			ro.disconnect();
			onData.dispose();
			onResize.dispose();
			ws?.close(1000, "leaving");
			term.dispose();
		};
	}, [sessionId, attempt, reconnectKey]);

	return (
		<div className="term">
			<div className="term__host" ref={host} />
			{phase !== "live" && (
				<div className={`term__overlay${phase === "connecting" ? " term__overlay--quiet" : ""}`}>
					{phase === "connecting" && <span className="mono tiny muted">attaching the terminal…</span>}
					{phase !== "connecting" && (
						<div className="term__notice">
							<div className="small">{detail ?? "The terminal is not connected."}</div>
							<button type="button" className="btn btn--small btn--primary" onClick={() => setAttempt((n) => n + 1)}>
								Reconnect
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
