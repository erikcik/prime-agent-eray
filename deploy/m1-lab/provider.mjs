#!/usr/bin/env node
// Registers the `m1-lab` provider in Prime Agent's models.json, pointing at the SSH tunnel.
// Only the model currently served on the M1 is listed: llama-server answers every request with the
// model it has loaded, whatever `model` the request names, so listing others would mislead /model.
//
//   node provider.mjs --base-url http://127.0.0.1:18080/v1 --id <alias> --name <label> \
//     --context 131072 --max-tokens 32768 [--api-key <value>] [--models-json <path>]
// --api-key takes a models.json config value: a literal, an env var name, or "!command".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? def : args[i + 1];
};

const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), ".prime", "agent");
const path = opt("models-json", join(agentDir, "models.json"));
const id = opt("id");
if (!id) {
	console.error("provider.mjs: --id is required");
	process.exit(2);
}

const provider = {
	name: "M1 lab (llama.cpp over SSH)",
	baseUrl: opt("base-url", "http://127.0.0.1:18080/v1"),
	api: "openai-completions",
	apiKey: opt("api-key", "m1-lab-local"),
	compat: {
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
		supportsUsageInStreaming: true,
		supportsReasoningEffort: true,
	},
	models: [
		{
			id,
			name: opt("name", id),
			reasoning: true,
			input: ["text"],
			contextWindow: Number(opt("context", "131072")),
			maxTokens: Number(opt("max-tokens", "32768")),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Qwen3.8's chat template accepts low | medium | xhigh (default xhigh when nothing is sent).
			// llama-server passes a top-level reasoning_effort into the template, and "none" renders an
			// empty think block, i.e. thinking off.
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "xhigh",
				xhigh: "xhigh",
				max: null,
			},
		},
	],
};

const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
config.providers ??= {};
config.providers["m1-lab"] = provider;
mkdirSync(dirname(path), { recursive: true });
const tmp = `${path}.m1-lab.tmp`;
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
renameSync(tmp, path);
console.log(`m1-lab provider -> ${path}: ${id} @ ${provider.baseUrl}`);
