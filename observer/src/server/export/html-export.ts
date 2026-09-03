import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DaemonCommands } from "../daemon/commands.ts";

/**
 * HTML transcript export. Live sessions use the daemon's `export_html` command. Saved sessions use
 * the harness's exportFromFile(), which is not in the package `exports` map, so it is reached via
 * a relative path into packages/coding-agent/dist — the ONLY non-public harness API the observer
 * touches, isolated here so a dist layout change fails loudly in one place.
 */
export class HtmlExporter {
	constructor(
		private readonly repoRoot: string,
		private readonly exportsDir: string,
	) {
		mkdirSync(exportsDir, { recursive: true });
	}

	outputPathFor(id: string): string {
		const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.exportsDir, `${safe}-${Date.now()}.html`);
	}

	async exportLive(commands: DaemonCommands, activeSessionId: string): Promise<string> {
		const out = this.outputPathFor(activeSessionId);
		const res = await commands.exportHtml(activeSessionId, out);
		return res?.path ?? out;
	}

	async exportSaved(sessionFile: string): Promise<string> {
		const modPath = join(this.repoRoot, "packages", "coding-agent", "dist", "core", "export-html", "index.js");
		const mod = (await import(pathToFileURL(modPath).href)) as {
			exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => Promise<string> | string;
		};
		if (typeof mod.exportFromFile !== "function") throw new Error(`exportFromFile not found in ${modPath}`);
		const out = this.outputPathFor(basename(sessionFile, ".jsonl"));
		const result = await mod.exportFromFile(sessionFile, { outputPath: out });
		return typeof result === "string" ? result : out;
	}
}
