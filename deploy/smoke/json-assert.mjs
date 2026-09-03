#!/usr/bin/env node
// Smoke check for a Prime Agent provider: runs `prime-agent --mode json -p ...` (or reads a
// saved JSONL event log) and asserts the event stream has the expected shape.
//
//   node deploy/smoke/json-assert.mjs --provider nano-gpt --model <id> [--tool] [--bin prime-agent]
//   node deploy/smoke/json-assert.mjs --file /path/to/events.jsonl [--tool]
//
// Exit 0 = all assertions passed. Prints a one-line summary plus any failures.
// Used on the Mac, inside the Docker image, and on the pod (see deploy/README.md).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const wantTool = flag("tool");
const file = opt("file");
const bin = opt("bin", "prime-agent");
const provider = opt("provider");
const model = opt("model");
const prompt = opt(
	"prompt",
	wantTool
		? "Using your ipython tool, compute 6*7 with Python and print it. Then reply with only the number."
		: "Reply with the single word: pong",
);

let raw;
if (file) {
	raw = readFileSync(file, "utf8");
} else {
	if (!provider || !model) {
		console.error("json-assert: need --provider and --model (or --file)");
		process.exit(2);
	}
	const cmd = [bin, "--mode", "json", "-p", "--provider", provider, "--model", model, prompt];
	const res = spawnSync(cmd[0], cmd.slice(1), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: Number(opt("timeout-ms", "300000")),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.error) {
		console.error(`json-assert: failed to run ${bin}: ${res.error.message}`);
		process.exit(2);
	}
	raw = res.stdout ?? "";
	if (res.status !== 0) {
		console.error(`json-assert: ${bin} exited ${res.status}\n${(res.stderr ?? "").slice(-2000)}`);
		process.exit(1);
	}
}

const events = [];
let badLines = 0;
for (const line of raw.split("\n")) {
	const t = line.trim();
	if (!t) continue;
	try {
		events.push(JSON.parse(t));
	} catch {
		badLines++;
	}
}

const failures = [];
const check = (cond, msg) => {
	if (!cond) failures.push(msg);
};
const types = events.map((e) => e.type);
const count = (t) => types.filter((x) => x === t).length;
const firstIdx = (t) => types.indexOf(t);
const lastIdx = (t) => types.lastIndexOf(t);

check(badLines === 0, `${badLines} unparsable JSON lines`);
check(types[0] === "session", `first event should be 'session', got '${types[0]}'`);
check(count("agent_start") === 1, `expected 1 agent_start, got ${count("agent_start")}`);
check(count("agent_end") === 1, `expected 1 agent_end, got ${count("agent_end")}`);
check(count("turn_start") >= 1, "expected at least one turn_start");
check(count("turn_end") >= 1, "expected at least one turn_end");
check(lastIdx("agent_end") === types.length - 1, "agent_end should be the last event");
check(firstIdx("agent_start") < firstIdx("turn_start"), "agent_start must precede turn_start");

const deltas = events.filter(
	(e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
).length;
check(deltas >= 1, "expected streamed text_delta events");

const assistantEnds = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
check(assistantEnds.length >= 1, "expected an assistant message_end");
const last = assistantEnds.at(-1);
const usage = last?.message?.usage;
check(usage && usage.input > 0 && usage.output > 0, "assistant usage.input/output should be > 0");
check(usage?.cost && typeof usage.cost.total === "number", "usage.cost.total should be reported");
if (provider) check(last?.message?.provider === provider, `provider should be ${provider}`);
if (model) check(last?.message?.model === model, `model should be ${model}`);

const toolStarts = count("tool_execution_start");
const toolEnds = events.filter((e) => e.type === "tool_execution_end");
if (wantTool) {
	check(toolStarts >= 1, "expected at least one tool_execution_start (ipython)");
	check(toolEnds.length >= 1, "expected at least one tool_execution_end");
	check(toolEnds.every((e) => e.isError !== true), "no tool_execution_end should have isError=true");
}

const finalText = (() => {
	const c = last?.message?.content;
	if (Array.isArray(c)) return c.filter((p) => p.type === "text").map((p) => p.text).join("");
	return typeof c === "string" ? c : "";
})();

const summary = {
	events: events.length,
	textDeltas: deltas,
	toolCalls: toolStarts,
	usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cost: usage.cost?.total } : null,
	finalText: finalText.trim().slice(0, 80),
};
console.log(`json-assert ${failures.length === 0 ? "PASS" : "FAIL"} ${JSON.stringify(summary)}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
