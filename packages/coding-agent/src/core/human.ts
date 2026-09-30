import type { ExtensionUIContext } from "./extensions/types.js";
import type { HostRequestHandler } from "./kernel/shared.js";

export const HUMAN_SKILL_NAME = "human";

const DONE = "Done";
const CANNOT = "I can't do it";

export interface HumanHostContext {
	/** The bound UI; undefined when no one can answer a dialog (print mode, subagents). */
	ui: () => ExtensionUIContext | undefined;
}

function requiredString(method: string, payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${method} ${key} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(method: string, payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${method} ${key} must be a string`);
	return value.trim() || undefined;
}

/**
 * Host side of the bundled human skill: the agent asks the operator for what
 * only a person can provide (SMS codes, identity checks, CAPTCHAs, decisions).
 * Each call opens a dialog in the attached UI and waits for the answer.
 */
export function createHumanHostHandlers(context: HumanHostContext): Record<string, HostRequestHandler> {
	const attachedUi = (method: string): ExtensionUIContext => {
		const ui = context.ui();
		if (!ui) throw new Error(`${method}: no operator is attached to this session`);
		return ui;
	};

	return {
		"human.ask": async (payload) => {
			const question = requiredString("human.ask", payload, "question");
			const placeholder = optionalString("human.ask", payload, "placeholder");
			const answer = await attachedUi("human.ask").input(`Question from the agent\n${question}`, placeholder);
			if (!answer?.trim()) throw new Error("the operator did not answer");
			return { answer: answer.trim() };
		},

		"human.choose": async (payload) => {
			const question = requiredString("human.choose", payload, "question");
			const options = payload.options;
			if (
				!Array.isArray(options) ||
				options.length < 2 ||
				!options.every((option) => typeof option === "string" && option.trim())
			) {
				throw new Error("human.choose options must be at least two non-empty strings");
			}
			const choice = await attachedUi("human.choose").select(`Question from the agent\n${question}`, options);
			if (choice === undefined) throw new Error("the operator did not answer");
			return { choice };
		},

		"human.handoff": async (payload) => {
			const task = requiredString("human.handoff", payload, "task");
			const why = optionalString("human.handoff", payload, "why");
			const url = optionalString("human.handoff", payload, "url");
			const ui = attachedUi("human.handoff");
			const details = [
				"The agent needs you to do this",
				task,
				why ? `Why: ${why}` : undefined,
				url ? `URL: ${url}` : undefined,
			].filter((line): line is string => line !== undefined);
			const choice = await ui.select(details.join("\n"), [DONE, CANNOT]);
			if (choice === undefined) throw new Error("the operator did not answer");
			const done = choice === DONE;
			const note = await ui.input(
				done ? "Anything the agent should know? (optional)" : "What should the agent do instead? (optional)",
				"optional note",
			);
			return { done, note: note?.trim() || null };
		},
	};
}
