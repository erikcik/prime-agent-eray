import { afterEach, describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.js";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_createKernelHostHandlers: () => Record<string, unknown>;
};

const PURCHASE_HANDLERS = ["purchase.request", "purchase.code", "purchase.budget"];

function handlerNames(harness: Harness): string[] {
	return Object.keys((harness.session as unknown as SessionInternals)._createKernelHostHandlers());
}

describe("purchase skill gating", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("exposes the purchase handlers only when the global settings carry a budget", async () => {
		const enabled = await createHarness({ settings: { purchase: { budget: 300 } } });
		const disabled = await createHarness();
		harnesses.push(enabled, disabled);

		expect(handlerNames(enabled)).toEqual(expect.arrayContaining(PURCHASE_HANDLERS));
		expect(handlerNames(disabled)).not.toContain("purchase.request");
	});

	it("keeps purchasing away from subagents", async () => {
		const child = await createHarness({ settings: { purchase: { budget: 300 } }, rlmDepth: 1 });
		harnesses.push(child);

		expect(handlerNames(child)).not.toContain("purchase.request");
	});

	it("ignores a purchase block in project settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ purchase: { budget: 300 } }));
		const settingsManager = SettingsManager.fromStorage(storage);

		expect(settingsManager.getPurchaseSettings()).toBeUndefined();
	});
});
