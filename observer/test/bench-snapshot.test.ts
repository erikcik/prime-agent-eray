import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionHeader } from "../src/server/disk/sessions-reader.ts";
import { buildSnapshotFile, filterHarnessState, pathToEntry, renderTranscript, resolveCut, toTimeline, windows } from "../src/server/bench/snapshot.ts";

const header: SessionHeader = { type: "session", version: 3, id: "orig", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/work", parentSession: "/x.jsonl" };

function msg(id: string, parentId: string | null, role: string, content: unknown, at = "2026-09-01T00:00:01.000Z", extra: Record<string, unknown> = {}): SessionEntry {
	return { type: "message", id, parentId, timestamp: at, message: { role, content, ...extra } };
}

// u1 -> a1 -> t1 -> a2 -> u2 -> a3 ; branch: a2 -> u2b
const entries: SessionEntry[] = [
	msg("u1", null, "user", "build the site"),
	msg("a1", "u1", "assistant", [{ type: "text", text: "on it" }, { type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } }]),
	msg("t1", "a1", "toolResult", [{ type: "text", text: "1" }, { type: "image", data: "xx", mimeType: "image/png" }], undefined, { toolName: "ipython" }),
	{ type: "agent_status", id: "s1", parentId: "t1", timestamp: "2026-09-01T00:00:02.000Z", status: { summary: "x" } },
	msg("a2", "s1", "assistant", [{ type: "text", text: "done step one" }]),
	msg("u2", "a2", "user", [{ type: "text", text: "now deploy it" }]),
	msg("a3", "u2", "assistant", [{ type: "text", text: "deployed" }]),
	msg("u2b", "a2", "user", "alternative branch"),
];

describe("snapshot surgery", () => {
	it("walks root to target", () => {
		expect(pathToEntry(entries, "a3").map((e) => e.id)).toEqual(["u1", "a1", "t1", "s1", "a2", "u2", "a3"]);
		expect(() => pathToEntry(entries, "nope")).toThrow();
	});

	it("cuts before a user message and uses its text as the prompt", () => {
		const cut = resolveCut(entries, "u2");
		expect(cut.cut).toBe("before-user-message");
		expect(cut.prompt).toBe("now deploy it");
		expect(cut.kept.map((e) => e.id)).toEqual(["u1", "a1", "t1", "s1", "a2"]);
	});

	it("keeps the anchor when cutting mid-turn", () => {
		const cut = resolveCut(entries, "t1");
		expect(cut.cut).toBe("mid-turn");
		expect(cut.prompt).toBeUndefined();
		expect(cut.kept.map((e) => e.id)).toEqual(["u1", "a1", "t1"]);
	});

	it("writes a forkable file: new id, new cwd, no parentSession, bookkeeping dropped and relinked", () => {
		const cut = resolveCut(entries, "u2");
		const lines = buildSnapshotFile(header, cut.kept, "snap-1", "/trial/ws").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ type: "session", id: "snap-1", cwd: "/trial/ws", version: 3 });
		expect(lines[0].parentSession).toBeUndefined();
		expect(lines.slice(1).map((e: SessionEntry) => e.id)).toEqual(["u1", "a1", "t1", "a2"]);
		expect(lines.find((e: SessionEntry) => e.id === "a2").parentId).toBe("t1");
		expect(lines.find((e: SessionEntry) => e.id === "u1").parentId).toBeNull();
	});

	it("renders a timeline with tool code and image counts", () => {
		const rows = toTimeline(pathToEntry(entries, "a3"));
		expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
		expect(rows[1]!.text).toContain("[tool call ipython] print(1)");
		expect(rows[2]!.imageCount).toBe(1);
		const text = renderTranscript(rows);
		expect(text).toContain("entry u2");
	});

	it("keeps head and tail when the transcript is over budget", () => {
		const many = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, parentId: null, at: "t", role: "assistant" as const, text: "x".repeat(500), imageCount: 0 }));
		const text = renderTranscript(many, 20_000);
		expect(text.length).toBeLessThan(22_000);
		expect(text).toContain("entry e0");
		expect(text).toContain("entry e199");
		expect(text).toMatch(/entries omitted/);
	});

	it("splits into overlapping windows that cover every row", () => {
		const rows = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, parentId: null, at: "t", role: "user" as const, text: "y".repeat(1000), imageCount: 0 }));
		const ws = windows(rows, 10_000, 2);
		expect(ws.length).toBeGreaterThan(1);
		const seen = new Set(ws.flat().map((r) => r.id));
		expect(seen.size).toBe(50);
		expect(ws[1]![0]!.id).toBe(ws[0]![ws[0]!.length - 2]!.id);
	});
});

describe("harness memory rewind", () => {
	const cutoff = "2026-09-10T12:00:00.000Z";
	const raw = {
		schema: 1,
		entries: {
			memory: {
				old: { id: "old", title: "old", content: "a", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
				solution: { id: "solution", title: "the answer", content: "do X", created_at: "2026-09-10T13:00:00Z", updated_at: "2026-09-10T13:00:00Z" },
				edited: { id: "edited", title: "edited", content: "new", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-11T00:00:00Z" },
				editedNoHistory: { id: "editedNoHistory", title: "e2", content: "new", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-11T00:00:00Z" },
				undated: { id: "undated", title: "undated", content: "?" },
			},
			prompt: {},
		},
		refinements: [
			{ id: "r0", created_at: "2026-09-02T00:00:00Z" },
			{ id: "r1", created_at: "2026-09-11T00:00:00Z" },
		],
	};
	const refinements = [
		{ timestamp: "2026-09-11T00:00:00Z", appliedEdits: [{ kind: "memory", id: "edited", before: { id: "edited", title: "edited", content: "old", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" } }] },
	];

	it("drops memories written after the checkpoint and restores edited ones", () => {
		const r = filterHarnessState(raw, cutoff, refinements);
		const mem = (r.state.entries as Record<string, Record<string, { content: string }>>).memory!;
		expect(Object.keys(mem).sort()).toEqual(["edited", "old"]);
		expect(mem.edited!.content).toBe("old");
		expect(r.excluded.map((e) => e.id).sort()).toEqual(["editedNoHistory", "solution", "undated"]);
		expect((r.state.refinements as unknown[]).length).toBe(1);
	});

	it("tolerates garbage", () => {
		expect(filterHarnessState(null, cutoff).included).toEqual([]);
		expect(filterHarnessState({ entries: { memory: { x: null } } }, cutoff).excluded.length).toBe(1);
	});
});
