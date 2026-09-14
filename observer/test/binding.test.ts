import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BINDING_STALE_SEC, BindingService } from "../src/server/binding/service.ts";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "binding-"));
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

function heartbeat(over: Record<string, unknown> = {}) {
	return {
		dest: "/Users/eraybaba/Desktop/prime-agent-pod",
		remote: "/workspace",
		host: "213.173.105.69",
		port: 29147,
		podId: "abc123",
		activity: "idle",
		lastResult: "ok",
		lastSyncAt: "2026-09-09T10:00:00Z",
		lastSyncDurationMs: 4200,
		filesTransferred: 12,
		bytesTransferred: 4096,
		localBytes: 1024,
		localFiles: 7,
		consecutiveFailures: 0,
		...over,
	};
}

describe("BindingService", () => {
	it("is unbound until a heartbeat lands", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.status();
		expect(status.phase).toBe("unbound");
		expect(status.heartbeat).toBeUndefined();
		expect(status.staleAfterSec).toBe(BINDING_STALE_SEC);
	});

	it("reports healthy on a fresh successful heartbeat", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept(heartbeat());
		expect(status.phase).toBe("healthy");
		expect(status.heartbeat?.dest).toBe("/Users/eraybaba/Desktop/prime-agent-pod");
		expect(status.heartbeat?.filesTransferred).toBe(12);
		expect(status.ageSec).toBe(0);
		expect(status.beats).toBe(1);
	});

	it("reports syncing while a pass is in flight", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept(heartbeat({ activity: "syncing" }));
		expect(status.phase).toBe("syncing");
	});

	it("reports syncing before the first pass has finished", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept(heartbeat({ activity: "idle", lastResult: undefined }));
		expect(status.phase).toBe("syncing");
	});

	it("reports failing when rsync errored", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept(heartbeat({ lastResult: "error", error: "rsync exit 255", consecutiveFailures: 3 }));
		expect(status.phase).toBe("failing");
		expect(status.heartbeat?.error).toBe("rsync exit 255");
		expect(status.heartbeat?.consecutiveFailures).toBe(3);
	});

	it("goes stale once nothing has been heard for longer than the window", async () => {
		vi.useFakeTimers();
		const s = new BindingService({ dataDir });
		await s.accept(heartbeat());
		expect((await s.status()).phase).toBe("healthy");
		vi.advanceTimersByTime((BINDING_STALE_SEC + 1) * 1000);
		const stale = await s.status();
		expect(stale.phase).toBe("stale");
		expect(stale.ageSec).toBeGreaterThan(BINDING_STALE_SEC);
	});

	// The whole point of the panel: an old "ok" must never be rendered as a working binding.
	it("prefers stale over the heartbeat's own claim of success", async () => {
		vi.useFakeTimers();
		const s = new BindingService({ dataDir });
		await s.accept(heartbeat({ lastResult: "ok", activity: "syncing" }));
		vi.advanceTimersByTime((BINDING_STALE_SEC + 60) * 1000);
		expect((await s.status()).phase).toBe("stale");
	});

	it("survives an observer restart by reloading the last heartbeat", async () => {
		const first = new BindingService({ dataDir });
		await first.accept(heartbeat());
		const second = new BindingService({ dataDir });
		const status = await second.status();
		expect(status.phase).toBe("healthy");
		expect(status.heartbeat?.podId).toBe("abc123");
		// Fresh process, so the accepted-beat counter starts over even though the record survived.
		expect(status.beats).toBe(0);
	});

	it("drops unknown fields and coerces wrong types", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept({
			dest: "/tmp/x",
			remote: "/workspace",
			activity: "nonsense",
			lastResult: "maybe",
			port: "not-a-number",
			filesTransferred: "12",
			evil: "<script>",
		});
		expect(status.heartbeat?.activity).toBe("idle");
		expect(status.heartbeat?.lastResult).toBeUndefined();
		expect(status.heartbeat?.port).toBeUndefined();
		expect(status.heartbeat?.filesTransferred).toBeUndefined();
		expect((status.heartbeat as Record<string, unknown>).evil).toBeUndefined();
		// No usable result yet, so it reads as a pass in flight rather than as success.
		expect(status.phase).toBe("syncing");
	});

	it("falls back to placeholders when the daemon sends nothing useful", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept({});
		expect(status.heartbeat?.dest).toBe("(unknown)");
		expect(status.heartbeat?.remote).toBe("/workspace");
	});

	it("truncates a huge rsync error instead of storing it whole", async () => {
		const s = new BindingService({ dataDir });
		const status = await s.accept(heartbeat({ lastResult: "error", error: "x".repeat(9000) }));
		expect(status.heartbeat?.error?.length).toBe(1200);
	});

	it("persists the heartbeat to disk", async () => {
		const s = new BindingService({ dataDir });
		await s.accept(heartbeat());
		const raw = JSON.parse(await readFile(join(dataDir, "binding.json"), "utf8"));
		expect(raw.heartbeat.podId).toBe("abc123");
		expect(typeof raw.receivedAt).toBe("string");
	});

	it("ignores a corrupt state file rather than throwing", async () => {
		await writeFile(join(dataDir, "binding.json"), "{ not json");
		const s = new BindingService({ dataDir });
		expect((await s.status()).phase).toBe("unbound");
	});
});
