import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionArtifacts, collectChildSessionFiles } from "../src/server/disk/artifacts-reader.ts";
import { buildHarnessView, loadHarnessState, mergeHarnessStates, mergeRefinementHistory } from "../src/server/disk/harness-reader.ts";
import { readFirstJsonLine, readJsonl, tailLines } from "../src/server/disk/jsonl.ts";
import { readLedgerEdges } from "../src/server/disk/ledger-reader.ts";
import { agentPaths, artifactDirForSessionFile, daemonLogPath } from "../src/server/disk/paths.ts";
import { listRootSessionFiles, parseSessionFile } from "../src/server/disk/sessions-reader.ts";
import { readSkills } from "../src/server/disk/skills-reader.ts";
import { buildFleetTree, flattenTree } from "../src/server/fleet/tree-builder.ts";

import { CHILD_ID, ROOT_ID, materializeFixture } from "./fixture.ts";

const FIXTURE = materializeFixture();
const paths = agentPaths(FIXTURE);
const rootFile = join(paths.sessionsDir, `${ROOT_ID}.jsonl`);
const childFile = join(paths.artifactsRoot, ROOT_ID, "sub-deadbeef", `${CHILD_ID}.jsonl`);

describe("jsonl", () => {
	it("reads tolerantly and counts bad lines", async () => {
		const r = await readJsonl(join(paths.sessionsDir, "broken.jsonl"));
		expect(r.entries).toHaveLength(1);
		expect(r.badLines).toBe(1);
	});
	it("reads the header line only", async () => {
		const h = await readFirstJsonLine<{ type: string; id: string }>(rootFile);
		expect(h?.type).toBe("session");
		expect(h?.id).toBe(ROOT_ID);
	});
	it("tails lines", async () => {
		const lines = await tailLines(rootFile, 2);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] ?? "{}").type).toBe("child_usage_attributed");
	});
});

describe("sessions-reader", () => {
	it("summarizes a root session", async () => {
		const p = await parseSessionFile(rootFile);
		const s = p.summary;
		expect(s.sessionId).toBe(ROOT_ID);
		expect(s.cwd).toBe("/tmp/project");
		expect(s.model).toBe("abliteration-ai/abliterated-model-large-v2");
		expect(s.provider).toBe("nano-gpt");
		expect(s.messageCount).toBe(3);
		expect(s.userMessageCount).toBe(1);
		expect(s.toolCallCount).toBe(1);
		expect(s.firstMessage).toBe("Build the thing");
		expect(s.agentStatus?.summary).toBe("Printed 1");
		expect(s.agentStatus?.taskState).toBe("completed");
		expect((s.goal as { objective: string }).objective).toBe("ship it");
		expect(s.usage.input).toBe(100);
		expect(s.usage.cost).toBeCloseTo(0.000605);
		expect(s.usage.childCost).toBeCloseTo(0.000275);
		expect(s.agentMessages).toHaveLength(1);
		expect(s.agentMessages[0]?.from.sessionName).toBe("helper");
		expect(s.agentMessages[0]?.relationship).toBe("child");
		expect(s.refinements).toHaveLength(1);
		expect(s.refinements[0]?.scope).toBe("local");
		expect(p.messages.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant", "toolResult"]);
	});
	it("lists root session files", async () => {
		const files = await listRootSessionFiles(paths.sessionsDir);
		expect(files.some((f) => f.endsWith(`${ROOT_ID}.jsonl`))).toBe(true);
	});
});

describe("artifacts-reader", () => {
	it("reads subagent records, schedules and local harness flag", async () => {
		const a = await readSessionArtifacts(artifactDirForSessionFile(rootFile));
		expect(a.hasLocalHarness).toBe(true);
		expect(a.scheduledJobs).toHaveLength(1);
		expect(a.subagents).toHaveLength(1);
		expect(a.subagents[0]?.childId).toBe("sub-deadbeef");
		expect(a.subagents[0]?.model).toBe("nano-gpt/abliteration-ai/abliterated-model-large-v2");
		expect(a.subagents[0]?.createdAt).toMatch(/^2026-09-0\dT10:00:03\.000Z$/);
	});
	it("collects nested child session files", async () => {
		const files = await collectChildSessionFiles(paths.artifactsRoot);
		expect(files.some((f) => f.endsWith(`${CHILD_ID}.jsonl`))).toBe(true);
	});
});

describe("ledger-reader", () => {
	it("replays spawn/delete", async () => {
		const edges = await readLedgerEdges(paths.ledgerDir);
		expect(edges).toHaveLength(2);
		const helper = edges.find((e) => e.childId === "sub-deadbeef");
		expect(helper?.name).toBe("helper");
		expect(helper?.deleted).toBe(false);
		const ghost = edges.find((e) => e.childId === "sub-00000001");
		expect(ghost?.deleted).toBe(true);
		expect(ghost?.deleteReason).toBe("user");
	});
});

describe("harness-reader", () => {
	it("loads, merges with scope-prefixed collisions, and merges history", async () => {
		const global = await loadHarnessState(paths.globalHarnessDir, "global");
		const local = await loadHarnessState(join(paths.artifactsRoot, ROOT_ID, "harness"), "local");
		expect(Object.keys(global.entries.prompt)).toEqual(["p-1"]);
		const merged = mergeHarnessStates(global, local);
		expect(Object.keys(merged.entries.memory).sort()).toEqual(["global:mem-1", "local:mem-1"]);
		expect(merged.entries.memory["local:mem-1"]?.content).toBe("Retry once.");
		expect(merged.entries.prompt["p-1"]?.scope).toBe("global");
		const missing = await loadHarnessState("/nonexistent/dir", "global");
		expect(Object.keys(missing.entries.memory)).toHaveLength(0);
		const parsed = await parseSessionFile(rootFile);
		const view = await buildHarnessView({ globalDir: paths.globalHarnessDir, localDir: join(paths.artifactsRoot, ROOT_ID, "harness"), sessionRefinements: parsed.summary.refinements });
		expect(view.history.map((h) => h.id).sort()).toEqual(["ref-0", "ref-1"]);
		const merged2 = mergeRefinementHistory([{ id: "x", summary: "g", appliedEdits: [] }], [{ id: "x", summary: "s", appliedEdits: [] }]);
		expect(merged2[0]?.summary).toBe("s");
	});
});

describe("skills-reader", () => {
	it("loads skills from the fixture agent dir", () => {
		const r = readSkills("/tmp", FIXTURE);
		expect(r.skills.some((s) => s.name === "hello-skill")).toBe(true);
	});
});

describe("tree-builder", () => {
	it("builds roots, children, deleted ghosts and counts", async () => {
		const disk = new Map();
		disk.set(rootFile, (await parseSessionFile(rootFile)).summary);
		disk.set(childFile, (await parseSessionFile(childFile)).summary);
		const edges = await readLedgerEdges(paths.ledgerDir);
		const tree = buildFleetTree({ roster: [], edges, disk, live: false });
		expect(tree.roots).toHaveLength(1);
		const root = tree.roots.find((r) => r.sessionId === ROOT_ID);
		expect(root?.children).toHaveLength(2);
		const helper = root?.children.find((c) => c.childId === "sub-deadbeef");
		expect(helper?.name).toBe("helper");
		expect(helper?.depth).toBe(1);
		expect(helper?.runtimeKind).toBe("subagent");
		expect(helper?.status).toBe("inactive");
		expect(root?.children.find((c) => c.childId === "sub-00000001")?.status).toBe("deleted");
		expect(tree.counts.subagents).toBe(2);
		expect(flattenTree(tree)).toHaveLength(3);
	});
	it("overlays a live roster entry", async () => {
		const disk = new Map();
		disk.set(rootFile, (await parseSessionFile(rootFile)).summary);
		const tree = buildFleetTree({
			roster: [
				{
					agentId: ROOT_ID,
					status: "running",
					summary: {
						id: "x",
						lifecycle: "live",
						activity: "working",
						isSessionActive: true,
						activeSessionId: "act-1",
						sessionId: ROOT_ID,
						sessionFile: rootFile,
						cwd: "/tmp/project",
						isStreaming: true,
						isCompacting: false,
						attachedClients: 0,
						messageCount: 9,
						runtimeKind: "top-level",
						model: { provider: "anthropic", id: "claude-opus-5" } as never,
					} as never,
				},
			],
			edges: [],
			disk,
			live: true,
		});
		const root = tree.roots[0];
		expect(root?.activeSessionId).toBe("act-1");
		expect(root?.status).toBe("running");
		expect(root?.model).toBe("anthropic/claude-opus-5");
		expect(root?.messageCount).toBe(9);
		expect(tree.counts.running).toBe(1);
	});
});

describe("paths", () => {
	it("derives the daemon log path like config.ts", () => {
		expect(daemonLogPath("/l", "/tmp/prime-agent-501/daemon.sock")).toMatch(/^\/l\/daemon\.sock\.[0-9a-f]{8}\.log$/);
	});
});
