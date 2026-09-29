import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { createPurchaseHostHandlers, readPurchaseLedger } from "../src/core/purchases.js";
import type { PurchaseSettings } from "../src/core/settings-manager.js";

interface ScriptedUi {
	ui: ExtensionUIContext;
	selects: Array<{ title: string; options: string[] }>;
	inputs: string[];
}

function scriptedUi(answers: { select?: Array<string | undefined>; input?: Array<string | undefined> }): ScriptedUi {
	const selects: ScriptedUi["selects"] = [];
	const inputs: string[] = [];
	const selectAnswers = [...(answers.select ?? [])];
	const inputAnswers = [...(answers.input ?? [])];
	const ui = {
		select: async (title: string, options: string[]) => {
			selects.push({ title, options });
			return selectAnswers.shift();
		},
		input: async (title: string) => {
			inputs.push(title);
			return inputAnswers.shift();
		},
	} as unknown as ExtensionUIContext;
	return { ui, selects, inputs };
}

const CARD = { number: "4111111111111111", expiry: "12/29", cvc: "123", name: "Bilgo AI" };

describe("purchase host handlers", () => {
	let tempDir: string;
	let ledgerPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-purchase-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		ledgerPath = join(tempDir, "purchases.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function handlers(settings: PurchaseSettings | undefined, ui: ExtensionUIContext | undefined) {
		return createPurchaseHostHandlers({
			settings: () => settings,
			ledgerPath,
			sessionId: () => "session-1",
			ui: () => ui,
			now: () => new Date("2026-09-29T10:00:00Z"),
		});
	}

	const request = {
		amount: 12,
		merchant: "Namecheap",
		description: "bilgo-demo.com domain",
		expected_outcome: "landing page for outbound",
		url: "https://namecheap.com/x",
	};

	it("returns the card only after the operator approves, and keeps it out of the ledger", async () => {
		const scripted = scriptedUi({ select: ["Approve"] });
		const result = await handlers({ budget: 300, card: CARD }, scripted.ui)["purchase.request"](request);

		expect(result).toMatchObject({ approved: true, remaining: 288, card: CARD });
		expect(scripted.selects).toHaveLength(1);
		expect(scripted.selects[0].options).toEqual(["Approve", "Reject"]);
		expect(scripted.selects[0].title).toContain("Namecheap — 12.00 USD");
		expect(scripted.selects[0].title).toContain("Why: landing page for outbound");
		expect(scripted.selects[0].title).toContain("288.00 USD after this");

		const ledger = readPurchaseLedger(ledgerPath);
		expect(ledger).toEqual([
			expect.objectContaining({ id: result.id, decision: "approved", amount: 12, sessionId: "session-1" }),
		]);
		expect(readFileSync(ledgerPath, "utf-8")).not.toContain(CARD.number);
	});

	it("sends the operator's rejection reason back to the agent", async () => {
		const scripted = scriptedUi({ select: ["Reject"], input: ["use the free tier first"] });
		const result = await handlers({ budget: 300, card: CARD }, scripted.ui)["purchase.request"](request);

		expect(result).toEqual({
			id: expect.any(String),
			approved: false,
			reason: "use the free tier first",
			remaining: 300,
		});
		expect(result).not.toHaveProperty("card");
		expect(readPurchaseLedger(ledgerPath)[0]).toMatchObject({
			decision: "rejected",
			reason: "use the free tier first",
		});
	});

	it("treats a dismissed dialog as a rejection", async () => {
		const scripted = scriptedUi({ select: [undefined] });
		const result = await handlers({ budget: 300, card: CARD }, scripted.ui)["purchase.request"](request);

		expect(result).toMatchObject({ approved: false, reason: expect.stringContaining("did not answer") });
		expect(scripted.inputs).toHaveLength(0);
	});

	it("rejects without asking when no operator is attached", async () => {
		const result = await handlers({ budget: 300, card: CARD }, undefined)["purchase.request"](request);

		expect(result).toMatchObject({ approved: false, reason: expect.stringContaining("no operator") });
	});

	it("rejects over-budget requests without asking and counts only approved spend", async () => {
		const scripted = scriptedUi({ select: ["Approve", "Reject"], input: [""] });
		const purchase = handlers({ budget: 20, card: CARD }, scripted.ui);

		await purchase["purchase.request"]({ ...request, amount: 15 });
		await purchase["purchase.request"]({ ...request, amount: 4 });
		const over = await purchase["purchase.request"]({ ...request, amount: 6 });

		expect(over).toMatchObject({ approved: false, reason: expect.stringContaining("5.00 USD left") });
		expect(scripted.selects).toHaveLength(2);
		expect(await purchase["purchase.budget"]({})).toMatchObject({ budget: 20, spent: 15, remaining: 5 });
	});

	it("does not record spend when the approved card cannot be resolved", async () => {
		const scripted = scriptedUi({ select: ["Approve"] });
		await expect(handlers({ budget: 300 }, scripted.ui)["purchase.request"](request)).rejects.toThrow(
			"no card is configured",
		);
		expect(readPurchaseLedger(ledgerPath)).toEqual([]);
	});

	it("asks the operator for a verification code on an approved purchase only", async () => {
		const scripted = scriptedUi({ select: ["Approve", "Reject"], input: [undefined, " 482913 "] });
		const purchase = handlers({ budget: 300, card: CARD }, scripted.ui);
		const approved = await purchase["purchase.request"](request);
		const rejected = await purchase["purchase.request"](request);

		await expect(purchase["purchase.code"]({ id: rejected.id })).rejects.toThrow("approved purchase");
		expect(await purchase["purchase.code"]({ id: approved.id })).toEqual({ code: "482913" });
		expect(scripted.inputs.at(-1)).toContain("Verification code for Namecheap");
	});

	it("validates the request and refuses when purchasing is off", async () => {
		const scripted = scriptedUi({});
		await expect(handlers(undefined, scripted.ui)["purchase.request"](request)).rejects.toThrow("not enabled");
		await expect(handlers({ budget: 0 }, scripted.ui)["purchase.budget"]({})).rejects.toThrow("not enabled");
		await expect(
			handlers({ budget: 300 }, scripted.ui)["purchase.request"]({ ...request, amount: -1 }),
		).rejects.toThrow("positive number");
		await expect(
			handlers({ budget: 300 }, scripted.ui)["purchase.request"]({ ...request, merchant: " " }),
		).rejects.toThrow("merchant");
		expect(scripted.selects).toHaveLength(0);
	});
});
