import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_BENCH_SETTINGS } from "../src/shared/bench.ts";
import { MetaAgent, extractJson, lastAssistantText, parseClaudeResult } from "../src/server/bench/meta-agent.ts";

const root = mkdtempSync(join(tmpdir(), "bench-meta-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Fake `claude`: records argv/env/stdin, answers like `claude -p --output-format json --json-schema`.
const fake = join(root, "fake-claude.sh");
writeFileSync(
	fake,
	`#!/bin/sh
printf '%s\\n' "$@" > "${root}/argv.txt"
printf '%s' "$CLAUDE_CONFIG_DIR|$CLAUDE_CODE_OAUTH_TOKEN|$PRIME_OBSERVER_TOKEN" > "${root}/env.txt"
cat > "${root}/stdin.txt"
echo '{"type":"result","is_error":false,"total_cost_usd":0.01,"result":"x","structured_output":{"ok":true,"n":2}}'
`,
);
chmodSync(fake, 0o755);

describe("meta agent (claude-code backend)", () => {
	it("passes the schema, disables tools, pipes the prompt on stdin, isolates config, strips observer secrets", async () => {
		const meta = new MetaAgent({
			settings: () => DEFAULT_BENCH_SETTINGS.meta,
			workDir: join(root, "work"),
			agentDir: join(root, "agent"),
			primeAgentBin: "prime-agent",
			claudeBin: fake,
			env: { PATH: process.env.PATH, ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-test", PRIME_OBSERVER_TOKEN: "secret-observer" },
		});
		const res = await meta.call<{ ok: boolean; n: number }>({ label: "t1", system: "SYS", prompt: "hello prompt", schema: { type: "object" } });
		expect(res.data).toEqual({ ok: true, n: 2 });
		expect(res.costUsd).toBe(0.01);
		const argv = readFileSync(join(root, "argv.txt"), "utf8").split("\n");
		expect(argv).toContain("--json-schema");
		expect(argv[argv.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
		expect(argv[argv.indexOf("--tools") + 1]).toBe("");
		expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
		expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("SYS");
		expect(readFileSync(join(root, "stdin.txt"), "utf8")).toBe("hello prompt");
		const [configDir, token, observerToken] = readFileSync(join(root, "env.txt"), "utf8").split("|");
		expect(configDir).toBe(join(root, "work", "cc-config-meta"));
		expect(token).toBe("sk-ant-oat01-test");
		expect(observerToken).toBe("");
	});

	it("grants read tools only when asked", async () => {
		const meta = new MetaAgent({ settings: () => DEFAULT_BENCH_SETTINGS.meta, workDir: join(root, "work2"), agentDir: root, primeAgentBin: "x", claudeBin: fake, env: { PATH: process.env.PATH } });
		await meta.call({ label: "t2", system: "S", prompt: "p", schema: {}, tools: "read", cwd: root });
		const argv = readFileSync(join(root, "argv.txt"), "utf8").split("\n");
		expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
		expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
	});
});

describe("result parsing", () => {
	it("reads structured_output and surfaces errors", () => {
		expect(parseClaudeResult('{"structured_output":{"a":1},"total_cost_usd":0.5}').data).toEqual({ a: 1 });
		expect(() => parseClaudeResult('{"is_error":true,"result":"rate limited"}')).toThrow(/rate limited/);
		expect(() => parseClaudeResult("not json")).toThrow();
		expect(parseClaudeResult('{"result":"here: {\\"b\\":2}"}').data).toEqual({ b: 2 });
	});

	it("extracts JSON from prose and fences", () => {
		expect(extractJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
		expect(extractJson('Sure! {"y":"a } b","z":[1,2]} done')).toEqual({ y: "a } b", z: [1, 2] });
		expect(extractJson("nothing here")).toBeUndefined();
	});

	it("takes the last non-empty assistant text and sums cost from a json event stream", () => {
		const stream = [
			'{"type":"session","id":"s"}',
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: { cost: { total: 0.1 } } } }),
			JSON.stringify({ type: "message_end", message: { role: "user", content: "u" } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"done":true}' }], usage: { cost: { total: 0.2 } } } }),
		].join("\n");
		const r = lastAssistantText(stream);
		expect(r.text).toBe('{"done":true}');
		expect(r.costUsd).toBeCloseTo(0.3);
	});
});
