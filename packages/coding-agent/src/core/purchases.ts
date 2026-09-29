import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionUIContext } from "./extensions/types.js";
import type { HostRequestHandler } from "./kernel/shared.js";
import { resolveConfigValueUncached } from "./resolve-config-value.js";
import type { PurchaseSettings } from "./settings-manager.js";

export const PURCHASE_SKILL_NAME = "purchase";
export const PURCHASE_LEDGER_FILE = "purchases.jsonl";

const APPROVE = "Approve";
const REJECT = "Reject";

export interface PurchaseLedgerEntry {
	id: string;
	time: string;
	sessionId: string;
	amount: number;
	currency: string;
	merchant: string;
	description: string;
	expectedOutcome?: string;
	url?: string;
	decision: "approved" | "rejected";
	/** Why the purchase was rejected: the operator's words, or the automatic reason. */
	reason?: string;
}

export interface PurchaseCard {
	number: string;
	expiry: string;
	cvc: string;
	name?: string;
}

export interface PurchaseHostContext {
	settings: () => PurchaseSettings | undefined;
	ledgerPath: string;
	sessionId: () => string;
	/** The bound UI; undefined when no one can answer a dialog (print mode, subagents). */
	ui: () => ExtensionUIContext | undefined;
	now?: () => Date;
}

/** Purchasing is on only when the global settings carry a positive budget. */
export function isPurchaseEnabled(settings: PurchaseSettings | undefined): boolean {
	return typeof settings?.budget === "number" && Number.isFinite(settings.budget) && settings.budget > 0;
}

export function readPurchaseLedger(path: string): PurchaseLedgerEntry[] {
	if (!existsSync(path)) return [];
	const entries: PurchaseLedgerEntry[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as PurchaseLedgerEntry);
		} catch {
			// A torn trailing line from a crash must not hide the rest of the ledger.
		}
	}
	return entries;
}

function appendPurchaseLedger(path: string, entry: PurchaseLedgerEntry): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function spentFrom(entries: PurchaseLedgerEntry[]): number {
	return entries.filter((entry) => entry.decision === "approved").reduce((sum, entry) => sum + entry.amount, 0);
}

function money(amount: number, currency: string): string {
	return `${amount.toFixed(2)} ${currency}`;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`purchase.request ${key} must be a string`);
	const trimmed = value.trim();
	return trimmed || undefined;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
	const value = optionalString(payload, key);
	if (!value) throw new Error(`purchase.request ${key} must be a non-empty string`);
	return value;
}

function resolveCard(settings: PurchaseSettings): PurchaseCard {
	const card = settings.card;
	if (!card?.number || !card.expiry || !card.cvc) {
		throw new Error(
			"the purchase was approved, but no card is configured (settings.json purchase.card needs number, expiry and cvc)",
		);
	}
	const resolve = (field: string, config: string): string => {
		const value = resolveConfigValueUncached(config);
		if (!value) throw new Error(`the purchase was approved, but the card ${field} could not be resolved`);
		return value;
	};
	return {
		number: resolve("number", card.number),
		expiry: resolve("expiry", card.expiry),
		cvc: resolve("cvc", card.cvc),
		name: card.name ? resolve("name", card.name) : undefined,
	};
}

function budgetStatus(settings: PurchaseSettings, entries: PurchaseLedgerEntry[]): Record<string, unknown> {
	const budget = settings.budget ?? 0;
	const spent = spentFrom(entries);
	return {
		budget,
		currency: settings.currency ?? "USD",
		spent,
		remaining: Math.max(0, budget - spent),
	};
}

/**
 * Host side of the bundled purchase skill. Every purchase waits for the
 * operator's decision in the attached UI; with no UI it is rejected. Card
 * credentials are resolved only after approval and never written to the ledger.
 */
export function createPurchaseHostHandlers(context: PurchaseHostContext): Record<string, HostRequestHandler> {
	const enabledSettings = (): PurchaseSettings => {
		const settings = context.settings();
		if (!isPurchaseEnabled(settings) || !settings) {
			throw new Error("purchasing is not enabled (set purchase.budget in the global settings.json)");
		}
		return settings;
	};

	return {
		"purchase.budget": async () => {
			const settings = enabledSettings();
			const entries = readPurchaseLedger(context.ledgerPath);
			return {
				...budgetStatus(settings, entries),
				history: entries.slice(-20).map((entry) => ({
					id: entry.id,
					time: entry.time,
					amount: entry.amount,
					merchant: entry.merchant,
					description: entry.description,
					decision: entry.decision,
					reason: entry.reason ?? null,
				})),
			};
		},

		"purchase.request": async (payload) => {
			const settings = enabledSettings();
			const currency = settings.currency ?? "USD";
			const amount = payload.amount;
			if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
				throw new Error("purchase.request amount must be a positive number");
			}
			const merchant = requiredString(payload, "merchant");
			const description = requiredString(payload, "description");
			const expectedOutcome = optionalString(payload, "expected_outcome");
			const url = optionalString(payload, "url");

			const entries = readPurchaseLedger(context.ledgerPath);
			const status = budgetStatus(settings, entries);
			const remaining = status.remaining as number;
			const entry: PurchaseLedgerEntry = {
				id: randomUUID().slice(0, 8),
				time: (context.now?.() ?? new Date()).toISOString(),
				sessionId: context.sessionId(),
				amount,
				currency,
				merchant,
				description,
				expectedOutcome,
				url,
				decision: "rejected",
			};
			const reject = (reason: string): Record<string, unknown> => {
				entry.reason = reason;
				appendPurchaseLedger(context.ledgerPath, entry);
				return { id: entry.id, approved: false, reason, remaining };
			};

			if (amount > remaining) {
				return reject(`exceeds the remaining budget (${money(remaining, currency)} left)`);
			}
			const ui = context.ui();
			if (!ui) {
				return reject("no operator is attached to approve purchases in this session");
			}

			const details = [
				`${merchant} — ${money(amount, currency)}`,
				`What: ${description}`,
				expectedOutcome ? `Why: ${expectedOutcome}` : undefined,
				url ? `URL: ${url}` : undefined,
				`Budget: ${money(remaining, currency)} left of ${money(settings.budget ?? 0, currency)}; ${money(remaining - amount, currency)} after this`,
			].filter((line): line is string => line !== undefined);
			const choice = await ui.select(`Purchase request\n${details.join("\n")}`, [APPROVE, REJECT]);
			if (choice !== APPROVE) {
				if (choice === undefined) {
					return reject("the operator did not answer (dialog dismissed or detached)");
				}
				const note = await ui.input("Why reject it? (sent back to the agent)", "optional reason");
				return reject(note?.trim() ? note.trim() : "rejected by the operator");
			}

			const card = resolveCard(settings);
			entry.decision = "approved";
			appendPurchaseLedger(context.ledgerPath, entry);
			return {
				id: entry.id,
				approved: true,
				remaining: remaining - amount,
				card: { number: card.number, expiry: card.expiry, cvc: card.cvc, name: card.name ?? null },
			};
		},

		"purchase.code": async (payload) => {
			enabledSettings();
			const id = typeof payload.id === "string" ? payload.id : undefined;
			const entry = readPurchaseLedger(context.ledgerPath).find(
				(candidate) => candidate.id === id && candidate.decision === "approved",
			);
			if (!entry) {
				throw new Error("purchase.code id must name an approved purchase");
			}
			const ui = context.ui();
			if (!ui) {
				throw new Error("no operator is attached to enter a verification code");
			}
			const hint = optionalString(payload, "prompt");
			const code = await ui.input(
				`Verification code for ${entry.merchant} — ${money(entry.amount, entry.currency)}${hint ? `\n${hint}` : ""}`,
				"code from the bank SMS",
			);
			if (!code?.trim()) {
				throw new Error("the operator did not enter a verification code");
			}
			return { code: code.trim() };
		},
	};
}
