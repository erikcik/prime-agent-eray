import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonl } from "./jsonl.ts";

/** Records in ~/.prime/agent/rlm-ledger/*.jsonl (packages/coding-agent/src/modes/daemon/rlm-ledger.ts). */
type LedgerRecord =
	| { v: 1; op: "meta"; [k: string]: unknown }
	| { v: 1; op: "spawn"; at: string; childId: string; parent: string; child: string; depth?: number; name?: string }
	| { v: 1; op: "rename"; at: string; childId: string; child: string; name?: string }
	| { v: 1; op: "delete"; at: string; childId: string; child: string; reason?: string };

export interface LedgerEdge {
	childId: string;
	parentFile: string;
	childFile: string;
	depth: number;
	name?: string;
	spawnedAt: string;
	deleted: boolean;
	deletedAt?: string;
	deleteReason?: string;
}

const MAX_LEDGER_BYTES = 32 * 1024 * 1024;

export async function readLedgerEdges(ledgerDir: string): Promise<LedgerEdge[]> {
	let files: string[];
	try {
		files = (await readdir(ledgerDir)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const edges = new Map<string, LedgerEdge>();
	for (const f of files) {
		let result: Awaited<ReturnType<typeof readJsonl<LedgerRecord>>>;
		try {
			result = await readJsonl<LedgerRecord>(join(ledgerDir, f), MAX_LEDGER_BYTES);
		} catch {
			continue;
		}
		for (const rec of result.entries) {
			if (!rec || typeof rec !== "object" || rec.v !== 1) continue;
			// Child ids are only unique per parent; the child path is daemon-wide unique.
			if (rec.op === "spawn") {
				const key = `${rec.childId}|${rec.child}`;
				edges.set(key, {
					childId: rec.childId,
					parentFile: rec.parent,
					childFile: rec.child,
					depth: typeof rec.depth === "number" ? rec.depth : 1,
					name: rec.name,
					spawnedAt: rec.at,
					deleted: false,
				});
			} else if (rec.op === "rename") {
				const e = edges.get(`${rec.childId}|${rec.child}`);
				if (e) e.name = rec.name ?? e.name;
			} else if (rec.op === "delete") {
				const e = edges.get(`${rec.childId}|${rec.child}`);
				if (e) {
					e.deleted = true;
					e.deletedAt = rec.at;
					e.deleteReason = rec.reason;
				}
			}
		}
	}
	return [...edges.values()].sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
}
