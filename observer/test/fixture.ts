import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_SRC = join(import.meta.dirname, "fixtures", "agent-dir");
export const ROOT_ID = "01a0aaaa-0000-7000-8000-000000000001";
export const CHILD_ID = "01a0bbbb-0000-7000-8000-000000000002";

/**
 * Copy the fixture agent dir into a temp dir and replace the __AGENT_DIR__ placeholder with the
 * real absolute path (session files, ledger edges and subagent records all carry absolute paths).
 */
export function materializeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "observer-fixture-"));
	cpSync(FIXTURE_SRC, dir, { recursive: true });
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(json|jsonl|md)$/.test(name)) {
				const s = readFileSync(p, "utf8");
				if (s.includes("__AGENT_DIR__")) writeFileSync(p, s.replaceAll("__AGENT_DIR__", dir));
			}
		}
	};
	walk(dir);
	return dir;
}
