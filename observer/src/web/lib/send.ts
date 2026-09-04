// Sending a message must survive every shape of restart, because the operator's mental model is
// simply "this session is mine, let me talk to it". Three distinct failures were observed on the
// pod, and each needs a different response:
//
//   1. session_not_live  — a pod restart leaves every session inactive (`activeSessionId: null`),
//      so POST /prompt is refused with 409. Nothing was delivered. Resume, then send.
//   2. the RunPod interstitial — the proxy serves its own "waiting for service" page while the
//      observer restarts (exit 87 after a Redeploy). The port was not accepting, so the request
//      provably never landed. Safe to re-send.
//   3. an ambiguous 5xx or a dropped connection — the proxy timed out upstream, or the socket
//      died mid-flight. The observer MAY have processed the request. Re-sending blindly would
//      duplicate a non-idempotent prompt, so we look for the message before trying again.
//
// Case 3 is why this lives in a tested module rather than inline in the component: "retry on
// error" is wrong here, and the difference is invisible until someone's prompt is sent twice.

import { ApiError, OBSERVER_RESTARTING } from "./api.ts";

export type SendMode = "prompt" | "steer" | "followUp";

/** How the send ultimately succeeded — surfaced so the UI can explain what it did. */
export type SendOutcome = "direct" | "resumed" | "retried" | "confirmed";

export interface SendApi {
	prompt(id: string, message: string): Promise<unknown>;
	steer(id: string, message: string): Promise<unknown>;
	followUp(id: string, message: string): Promise<unknown>;
	resumeSession(id: string, cwd?: string): Promise<{ activeSessionId?: string }>;
	messages(id: string, opts?: { before?: number; limit?: number }): Promise<{ messages: unknown[] }>;
}

export interface SendOptions {
	id: string;
	mode: SendMode;
	body: string;
	api: SendApi;
	/** Progress for the banner, e.g. "the observer is restarting". */
	onStatus?: (message: string) => void;
	/** Injected in tests so the suite does not actually wait. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Total wall-clock budget. A pod redeploy measured 35-60s; a container restart can exceed it. */
	budgetMs?: number;
}

const DEFAULT_BUDGET_MS = 120_000;
const MAX_BACKOFF_MS = 8_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoffFor(attempt: number): number {
	return Math.min(2000 + attempt * 1000, MAX_BACKOFF_MS);
}

/** A 409 the server tags explicitly: the session exists on disk but has no live worker. */
function isNotLive(error: unknown): boolean {
	return error instanceof ApiError && (error.code === "session_not_live" || error.status === 409);
}

/** The proxy's own page: the observer was not listening, so nothing was delivered. */
function isDefinitelyUndelivered(error: unknown): boolean {
	return error instanceof ApiError && error.code === OBSERVER_RESTARTING;
}

/**
 * Might have landed, might not: a bare 5xx (upstream timeout) or a transport failure that
 * produced no status at all. Never re-send one of these without checking first.
 */
function isAmbiguous(error: unknown): boolean {
	if (!(error instanceof ApiError)) return true; // a thrown TypeError from fetch: no status at all
	return error.status === 0 || error.status >= 500;
}

function textOfMessage(message: unknown): string {
	const m = message as { role?: string; content?: unknown };
	const c = m?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
			.join("");
	}
	return "";
}

/**
 * Did our exact message already reach the transcript? Used only after an ambiguous failure, to
 * tell "the observer never saw it" from "the observer took it and the reply got lost".
 */
export async function messageLanded(api: SendApi, id: string, body: string): Promise<boolean> {
	try {
		const page = await api.messages(id, { limit: 30 });
		return (page.messages ?? []).some((m) => {
			const rec = m as { role?: string };
			if (rec?.role !== "user") return false;
			return textOfMessage(m).trim() === body.trim();
		});
	} catch {
		// If we cannot check, report "not landed" so the caller keeps trying rather than
		// silently dropping the operator's message.
		return false;
	}
}

/**
 * Deliver a composer message, recovering from restarts. Resolves with how it got through, or
 * throws the last error once the budget is spent.
 */
export async function sendWithRecovery(options: SendOptions): Promise<SendOutcome> {
	const { id, mode, body, api } = options;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? (() => Date.now());
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const deadline = now() + budgetMs;
	const status = (m: string) => options.onStatus?.(m);

	const deliver = async (): Promise<void> => {
		if (mode === "prompt") await api.prompt(id, body);
		else if (mode === "steer") await api.steer(id, body);
		else await api.followUp(id, body);
	};

	let outcome: SendOutcome = "direct";
	let resumeAttempted = false;

	for (let attempt = 0; ; attempt++) {
		try {
			await deliver();
			return outcome;
		} catch (error) {
			const timeLeft = deadline - now();

			if (isNotLive(error)) {
				// A pod restart left the session on disk with no worker. Nothing was delivered,
				// so bringing it back and re-sending cannot duplicate anything.
				if (resumeAttempted && timeLeft <= 0) throw error;
				status("Session is not live — resuming it…");
				try {
					await api.resumeSession(id);
				} catch (resumeError) {
					throw resumeError;
				}
				resumeAttempted = true;
				outcome = "resumed";
				// The worker needs a moment before it accepts prompts.
				await sleep(backoffFor(attempt));
				if (now() >= deadline) throw error;
				continue;
			}

			if (isDefinitelyUndelivered(error)) {
				if (timeLeft <= 0) throw error;
				status("The observer is restarting — retrying…");
				outcome = "retried";
				await sleep(backoffFor(attempt));
				continue;
			}

			if (isAmbiguous(error)) {
				if (timeLeft <= 0) throw error;
				status("Connection lost — checking whether the message arrived…");
				await sleep(backoffFor(attempt));
				// The decisive check: never re-send something that already landed.
				if (await messageLanded(api, id, body)) return "confirmed";
				outcome = "retried";
				continue;
			}

			// A real application error (400 bad request, 404 unknown session, 401): surface it.
			throw error;
		}
	}
}
