import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * scroll.ts touches window/document; stub just enough of them to drive the frame loop by hand.
 * `frames` is the pending requestAnimationFrame queue; `tick(ms)` advances the clock and runs it.
 */
interface Fake {
	scrollY: number;
	scrollHeight: number;
	innerHeight: number;
	visibility: string;
	reduced: boolean;
	now: number;
	frames: Map<number, (t: number) => void>;
	calls: number[];
}

let fake: Fake;
let nextFrame = 1;

function tick(ms: number): void {
	fake.now += ms;
	const due = [...fake.frames.entries()];
	fake.frames.clear();
	for (const [, cb] of due) cb(fake.now);
}

beforeEach(() => {
	fake = { scrollY: 0, scrollHeight: 5000, innerHeight: 800, visibility: "visible", reduced: false, now: 1000, frames: new Map(), calls: [] };
	vi.stubGlobal("window", {
		get scrollY() {
			return fake.scrollY;
		},
		get innerHeight() {
			return fake.innerHeight;
		},
		scrollTo(_x: number, y: number) {
			fake.scrollY = y;
			fake.calls.push(y);
		},
	});
	vi.stubGlobal("document", {
		documentElement: {
			get scrollHeight() {
				return fake.scrollHeight;
			},
		},
		get visibilityState() {
			return fake.visibility;
		},
	});
	vi.stubGlobal("matchMedia", () => ({ matches: fake.reduced }));
	vi.stubGlobal("performance", { now: () => fake.now });
	vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
		const id = nextFrame++;
		fake.frames.set(id, cb);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => fake.frames.delete(id));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

async function load() {
	return import("../src/web/lib/scroll.ts");
}

describe("followToBottom", () => {
	it("glides with an eased, monotonic progression and lands exactly at the bottom", async () => {
		const { followToBottom } = await load();
		fake.scrollY = 3000; // bottom is 4200: 1200px away, well under three viewports
		followToBottom();
		expect(fake.calls).toEqual([]); // nothing until the first frame
		for (let i = 0; i < 40 && fake.frames.size > 0; i++) tick(16);
		expect(fake.calls.length).toBeGreaterThan(10);
		for (let i = 1; i < fake.calls.length; i++) expect(fake.calls[i]).toBeGreaterThanOrEqual(fake.calls[i - 1]!);
		// ease-out: the first frame covers more ground than the last one
		const first = fake.calls[0]! - 3000;
		const last = fake.calls.at(-1)! - fake.calls.at(-2)!;
		expect(first).toBeGreaterThan(last);
		expect(fake.calls.at(-1)).toBe(4200);
		expect(fake.frames.size).toBe(0);
	});

	it("keeps following a page that grows during the glide", async () => {
		const { followToBottom } = await load();
		fake.scrollY = 3500;
		followToBottom();
		tick(16);
		fake.scrollHeight = 6000; // a streaming reply added content mid-animation
		for (let i = 0; i < 40 && fake.frames.size > 0; i++) tick(16);
		expect(fake.calls.at(-1)).toBe(5200);
	});

	it("jumps instantly when far away, when the tab is hidden, or with reduced motion", async () => {
		const { followToBottom } = await load();
		followToBottom(); // 4200px away from 0: more than three viewports
		expect(fake.calls).toEqual([4200]);
		expect(fake.frames.size).toBe(0);

		fake.scrollY = 3000;
		fake.visibility = "hidden";
		followToBottom();
		expect(fake.calls.at(-1)).toBe(4200);
		expect(fake.frames.size).toBe(0);

		fake.scrollY = 3000;
		fake.visibility = "visible";
		fake.reduced = true;
		followToBottom();
		expect(fake.calls.at(-1)).toBe(4200);
		expect(fake.frames.size).toBe(0);
	});

	it("restarts from the current position when called again mid-glide, and does nothing at the bottom", async () => {
		const { followToBottom, cancelFollow } = await load();
		fake.scrollY = 3000;
		followToBottom();
		tick(16);
		tick(16);
		const mid = fake.scrollY;
		followToBottom(); // e.g. the next streaming token
		expect(fake.frames.size).toBe(1); // the old frame was cancelled, one new one pending
		tick(16);
		expect(fake.scrollY).toBeGreaterThanOrEqual(mid);
		cancelFollow();
		expect(fake.frames.size).toBe(0);

		fake.scrollY = 4200;
		fake.calls.length = 0;
		followToBottom();
		expect(fake.calls).toEqual([]);
	});
});
