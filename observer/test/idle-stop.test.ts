import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IdleStopService } from "../src/server/idle/idle-stop.ts";

const MIN = 60_000;

function harness(busy: () => Promise<string[]>, stop: () => Promise<void> = async () => undefined) {
	let t = 1_000_000;
	const stops: number[] = [];
	const dataDir = mkdtempSync(join(tmpdir(), "idle-stop-"));
	const svc = new IdleStopService({
		idleMinutes: 30,
		dataDir,
		probe: busy,
		stop: async () => {
			stops.push(t);
			await stop();
		},
		now: () => t,
	});
	return {
		svc,
		stops,
		dataDir,
		advance: async (ms: number) => {
			t += ms;
			await svc.tick();
		},
	};
}

describe("IdleStopService", () => {
	it("gives a freshly booted pod a full window before stopping", async () => {
		const h = harness(async () => []);
		await h.advance(29 * MIN);
		expect(h.stops).toHaveLength(0);
		expect(h.svc.status().stopAt).toBeDefined();
		await h.advance(1 * MIN);
		expect(h.stops).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(h.dataDir, "idle-stop.json"), "utf8")).idleSince).toBeDefined();
	});

	it("restarts the window whenever anything is busy", async () => {
		let reasons: string[] = [];
		const h = harness(async () => reasons);
		await h.advance(20 * MIN);
		reasons = ["agent a is working"];
		await h.advance(1 * MIN);
		expect(h.svc.status().busy).toEqual(["agent a is working"]);
		expect(h.svc.status().stopAt).toBeUndefined();
		reasons = [];
		await h.advance(29 * MIN);
		expect(h.stops).toHaveLength(0);
		await h.advance(1 * MIN);
		expect(h.stops).toHaveLength(1);
	});

	it("never stops when the probe fails", async () => {
		const h = harness(async () => {
			throw new Error("daemon list timed out");
		});
		for (let i = 0; i < 120; i++) await h.advance(1 * MIN);
		expect(h.stops).toHaveLength(0);
		expect(h.svc.status().busy[0]).toContain("probe failed");
	});

	it("stops once, and retries a failed stop only after another full window", async () => {
		let fail = true;
		const h = harness(
			async () => [],
			async () => {
				if (fail) throw new Error("RunPod stop 500");
			},
		);
		await h.advance(30 * MIN);
		expect(h.stops).toHaveLength(1);
		expect(h.svc.status().lastError).toContain("500");
		await h.advance(10 * MIN);
		expect(h.stops).toHaveLength(1);
		fail = false;
		await h.advance(20 * MIN);
		expect(h.stops).toHaveLength(2);
		expect(h.svc.status().stopping).toBe(true);
		await h.advance(30 * MIN);
		expect(h.stops).toHaveLength(2);
		expect(existsSync(join(h.dataDir, "idle-stop.json"))).toBe(true);
	});
});
