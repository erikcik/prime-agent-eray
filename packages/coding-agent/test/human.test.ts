import { describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { createHumanHostHandlers } from "../src/core/human.js";

interface ScriptedUi {
	ui: ExtensionUIContext;
	selects: Array<{ title: string; options: string[] }>;
	inputs: Array<{ title: string; placeholder?: string }>;
}

function scriptedUi(answers: { select?: Array<string | undefined>; input?: Array<string | undefined> }): ScriptedUi {
	const selects: ScriptedUi["selects"] = [];
	const inputs: ScriptedUi["inputs"] = [];
	const selectAnswers = [...(answers.select ?? [])];
	const inputAnswers = [...(answers.input ?? [])];
	const ui = {
		select: async (title: string, options: string[]) => {
			selects.push({ title, options });
			return selectAnswers.shift();
		},
		input: async (title: string, placeholder?: string) => {
			inputs.push({ title, placeholder });
			return inputAnswers.shift();
		},
	} as unknown as ExtensionUIContext;
	return { ui, selects, inputs };
}

describe("human host handlers", () => {
	it("asks the operator and returns the trimmed answer", async () => {
		const scripted = scriptedUi({ input: ["  482913 "] });
		const handlers = createHumanHostHandlers({ ui: () => scripted.ui });

		const reply = await handlers["human.ask"]({ question: "Twilio SMS code?", placeholder: "6 digits" });

		expect(reply).toEqual({ answer: "482913" });
		expect(scripted.inputs).toEqual([
			{ title: "Question from the agent\nTwilio SMS code?", placeholder: "6 digits" },
		]);
	});

	it("rejects an empty or dismissed answer", async () => {
		const scripted = scriptedUi({ input: [undefined, "   "] });
		const handlers = createHumanHostHandlers({ ui: () => scripted.ui });

		await expect(handlers["human.ask"]({ question: "code?" })).rejects.toThrow("did not answer");
		await expect(handlers["human.ask"]({ question: "code?" })).rejects.toThrow("did not answer");
	});

	it("offers the given options and returns the choice", async () => {
		const scripted = scriptedUi({ select: ["Cartesia"] });
		const handlers = createHumanHostHandlers({ ui: () => scripted.ui });

		const reply = await handlers["human.choose"]({
			question: "Voice provider?",
			options: ["ElevenLabs", "Cartesia"],
		});

		expect(reply).toEqual({ choice: "Cartesia" });
		expect(scripted.selects[0].options).toEqual(["ElevenLabs", "Cartesia"]);
		await expect(handlers["human.choose"]({ question: "x", options: ["only one"] })).rejects.toThrow("at least two");
	});

	it("hands a step to the operator and returns done with the note", async () => {
		const scripted = scriptedUi({ select: ["Done"], input: ["used my passport"] });
		const handlers = createHumanHostHandlers({ ui: () => scripted.ui });

		const reply = await handlers["human.handoff"]({
			task: "Complete the Stripe identity check",
			why: "payouts need a verified person",
			url: "https://dashboard.stripe.com/account/onboarding",
		});

		expect(reply).toEqual({ done: true, note: "used my passport" });
		expect(scripted.selects[0].title).toContain("Complete the Stripe identity check");
		expect(scripted.selects[0].title).toContain("Why: payouts need a verified person");
		expect(scripted.selects[0].title).toContain("URL: https://dashboard.stripe.com/account/onboarding");
	});

	it("reports a handoff the operator cannot do, with a null note when none is given", async () => {
		const scripted = scriptedUi({ select: ["I can't do it"], input: [""] });
		const handlers = createHumanHostHandlers({ ui: () => scripted.ui });

		expect(await handlers["human.handoff"]({ task: "Call the bank" })).toEqual({ done: false, note: null });
	});

	it("fails clearly when no operator is attached", async () => {
		const handlers = createHumanHostHandlers({ ui: () => undefined });

		await expect(handlers["human.ask"]({ question: "code?" })).rejects.toThrow("no operator is attached");
		await expect(handlers["human.handoff"]({ task: "x" })).rejects.toThrow("no operator is attached");
	});
});
