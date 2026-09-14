import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WorkspaceRecorder } from "../src/server/bench/recorder.ts";

const root = mkdtempSync(join(tmpdir(), "bench-recorder-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("workspace recorder", () => {
	it("records, dedupes, finds the nearest commit before a time, and restores files", async () => {
		const ws = join(root, "ws");
		mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(ws, ".git"), { recursive: true });
		writeFileSync(join(ws, "a.txt"), "v1");
		writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "ignored");
		writeFileSync(join(ws, ".git", "HEAD"), "project git must stay untouched");
		const rec = new WorkspaceRecorder(join(root, "shadow"));

		const c1 = await rec.record(ws, "first");
		expect(c1?.commit).toMatch(/^[0-9a-f]{40}$/);
		const same = await rec.record(ws, "no change");
		expect(same?.commit).toBe(c1?.commit);

		await new Promise((r) => setTimeout(r, 1100));
		const between = new Date().toISOString();
		await new Promise((r) => setTimeout(r, 1100));
		writeFileSync(join(ws, "a.txt"), "v2");
		writeFileSync(join(ws, "b.txt"), "new");
		const c2 = await rec.record(ws, "second");
		expect(c2?.commit).not.toBe(c1?.commit);

		const near = await rec.nearest(ws, between);
		expect(near?.commit).toBe(c1?.commit);
		expect(await rec.fileCount(ws, c1!.commit)).toBe(1);

		const out = join(root, "restore");
		mkdirSync(out);
		await rec.materialize(ws, near!.commit, out);
		expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("v1");
		expect(() => readFileSync(join(out, "b.txt"))).toThrow();
		expect(() => readFileSync(join(out, "node_modules", "pkg", "index.js"))).toThrow();
		expect(readFileSync(join(ws, ".git", "HEAD"), "utf8")).toBe("project git must stay untouched");
	});

	it("refuses home, root, and its own directories", () => {
		const rec = new WorkspaceRecorder(join(root, "shadow2"), { skipUnder: [join(root, "trials")] });
		expect(rec.recordable("/")).toBe(false);
		expect(rec.recordable(process.env.HOME)).toBe(false);
		expect(rec.recordable(join(root, "shadow2", "x"))).toBe(false);
		expect(rec.recordable(join(root, "trials", "t1"))).toBe(false);
		expect(rec.recordable(join(root, "missing"))).toBe(false);
		expect(rec.recordable(root)).toBe(true);
	});
});
