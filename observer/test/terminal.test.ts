import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { encodeWsBearer } from "../src/server/auth.ts";
import { startServer } from "../src/server/main.ts";
import { TERM_WS_PROTOCOL } from "../src/shared/ws.ts";
import { ROOT_ID, materializeFixture } from "./fixture.ts";

const TOKEN = "terminal-test-token-0123456789";
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let dir: string;

/**
 * A stand-in for `prime-agent` that proves what the hub hands it: it prints its arguments and
 * the environment the TUI cares about, then becomes an echo shell so input, resize and exit can
 * be observed through the PTY.
 */
const FAKE_LAUNCHER = `#!/bin/sh
echo "ARGS: $*"
echo "AGENT_DIR: $PRIME_AGENT_CODING_AGENT_DIR"
echo "TERM: $TERM"
echo "TOKEN_LEAK: \${PRIME_OBSERVER_TOKEN:-none}"
echo "CWD: $(pwd)"
while IFS= read -r line; do
  case "$line" in
    size) stty size ;;
    quit) exit 7 ;;
    *) echo "echo:$line" ;;
  esac
done
`;

beforeAll(async () => {
	dir = materializeFixture();
	const bin = join(dir, "fake-prime-agent.sh");
	writeFileSync(bin, FAKE_LAUNCHER);
	chmodSync(bin, 0o755);
	server = await startServer({
		PRIME_OBSERVER_PORT: "0",
		PRIME_OBSERVER_TOKEN: TOKEN,
		PRIME_AGENT_CODING_AGENT_DIR: dir,
		PRIME_AGENT_DAEMON_SOCKET: `${dir}/no-such-daemon.sock`,
		PRIME_OBSERVER_DEPLOY_HOOK: `${dir}/no-hook.sh`,
		PRIME_OBSERVER_PRIME_AGENT_BIN: bin,
	});
	base = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await server.close();
});

interface Term {
	ws: WebSocket;
	out: () => string;
	waitFor: (re: RegExp, ms?: number) => Promise<string>;
	json: (msg: unknown) => void;
	closed: Promise<{ code: number; reason: string }>;
}

function open(session: string, opts: { token?: string; origin?: string } = {}): Term {
	const protocols = [TERM_WS_PROTOCOL, ...(opts.token ? [encodeWsBearer(opts.token)] : [])];
	const ws = new WebSocket(`${base}/ws/term?session=${encodeURIComponent(session)}`, protocols, { headers: opts.origin ? { origin: opts.origin } : {} });
	let buf = "";
	const control: unknown[] = [];
	ws.on("message", (data, isBinary) => {
		if (isBinary) buf += data.toString("utf8");
		else control.push(JSON.parse(data.toString()));
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
	const waitFor = (re: RegExp, ms = 5000) =>
		new Promise<string>((resolve, reject) => {
			const t0 = Date.now();
			const tick = () => {
				const m = re.exec(buf);
				if (m) return resolve(m[0]);
				if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${re}; got:\n${buf}\ncontrol: ${JSON.stringify(control)}`));
				setTimeout(tick, 25);
			};
			tick();
		});
	return { ws, out: () => buf, waitFor, json: (msg) => ws.send(JSON.stringify(msg)), closed };
}

function opened(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
}

describe("terminal socket", () => {
	it("rejects a missing bearer, a query token, and a foreign origin", async () => {
		const noAuth = open(ROOT_ID);
		await opened(noAuth.ws);
		expect((await noAuth.closed).code).toBe(4401);

		const query = new WebSocket(`${base}/ws/term?session=${ROOT_ID}&token=${TOKEN}`, [TERM_WS_PROTOCOL, encodeWsBearer(TOKEN)]);
		await expect(opened(query)).rejects.toThrow();

		const evil = open(ROOT_ID, { token: TOKEN, origin: "https://evil.example" });
		await expect(opened(evil.ws)).rejects.toThrow();
	});

	it("resumes the session file in its cwd with a scrubbed env, and round-trips input, resize and exit", async () => {
		const t = open(ROOT_ID, { token: TOKEN });
		await opened(t.ws);
		t.json({ t: "open", cols: 100, rows: 30 });
		// PTY output is CRLF and `.` does not match \r, hence the explicit classes.
		const args = await t.waitFor(/ARGS: [^\r\n]*/);
		expect(args).toContain("--resume");
		expect(args).toContain(`${dir}/sessions/${ROOT_ID}.jsonl`);
		expect(args).toContain("--daemon-socket");
		await t.waitFor(/AGENT_DIR: [^\r\n]+/).then((l) => expect(l.trim().endsWith(dir)).toBe(true));
		await t.waitFor(/TERM: xterm-256color/);
		await t.waitFor(/TOKEN_LEAK: none/);
		// The fixture's cwd (/tmp/project) does not exist, so the launcher falls back to the repo root.
		await t.waitFor(/CWD: \S+/).then((l) => expect(l).not.toContain("/tmp/project"));

		t.json({ t: "in", data: "hello terminal\n" });
		await t.waitFor(/echo:hello terminal/);

		t.json({ t: "resize", cols: 132, rows: 43 });
		t.json({ t: "in", data: "size\n" });
		await t.waitFor(/\r?\n43 132/);

		t.json({ t: "in", data: "quit\n" });
		const end = await t.closed;
		expect(end.code).toBe(1000);
	});

	it("refuses an unknown session and a second open on the same socket", async () => {
		const bad = open("no-such-session", { token: TOKEN });
		await opened(bad.ws);
		bad.json({ t: "open", cols: 80, rows: 24 });
		expect((await bad.closed).code).toBe(4404);

		const t = open(ROOT_ID, { token: TOKEN });
		await opened(t.ws);
		t.json({ t: "open", cols: 80, rows: 24 });
		await t.waitFor(/ARGS:/);
		const errors: string[] = [];
		t.ws.on("message", (data, isBinary) => {
			if (!isBinary) errors.push(data.toString());
		});
		t.json({ t: "open", cols: 80, rows: 24 });
		await new Promise((r) => setTimeout(r, 150));
		expect(errors.some((e) => e.includes("already open"))).toBe(true);
		t.ws.close();
		await t.closed;
	});

	it("kills the process when the socket closes", async () => {
		const t = open(ROOT_ID, { token: TOKEN });
		await opened(t.ws);
		t.json({ t: "open", cols: 80, rows: 24 });
		await t.waitFor(/ARGS:/);
		t.ws.close();
		await t.closed;
		// The fake launcher only exits on "quit" or a hangup; if the PTY were leaked it would linger.
		await new Promise((r) => setTimeout(r, 300));
		const { execSync } = await import("node:child_process");
		// ps rather than pgrep -f: pgrep's own `sh -c` wrapper would match the pattern.
		const survivors = execSync("ps -axo command")
			.toString()
			.split("\n")
			.filter((l) => l.startsWith("/bin/sh ") && l.includes("fake-prime-agent.sh --resume"));
		expect(survivors).toEqual([]);
	});
});
