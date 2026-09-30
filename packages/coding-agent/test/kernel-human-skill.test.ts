import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledHumanSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "human");
	return {
		name: "human",
		importName: "human",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("human skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-human-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips ask, choose and handoff", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledHumanSkill()],
			hostHandlers: {
				"human.ask": async (payload) => {
					requests.push({ type: "human.ask", payload });
					return { answer: "482913" };
				},
				"human.choose": async (payload) => {
					requests.push({
						type: "human.choose",
						payload,
					});
					return { choice: "Cartesia" };
				},
				"human.handoff": async (payload) => {
					requests.push({
						type: "human.handoff",
						payload,
					});
					return { done: false, note: "use the email signup instead" };
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
print(await human.ask("Twilio SMS code?", placeholder="6 digits"))
print(await human.choose("Voice provider?", ["ElevenLabs", "Cartesia"]))
_h = await human.handoff("Complete the ID check", url="https://example.com/verify")
print(_h.done, _h.note)
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual(["482913", "Cartesia", "False use the email signup instead"]);
		expect(requests).toEqual([
			{
				type: "human.ask",
				payload: expect.objectContaining({ question: "Twilio SMS code?", placeholder: "6 digits" }),
			},
			{
				type: "human.choose",
				payload: expect.objectContaining({ question: "Voice provider?", options: ["ElevenLabs", "Cartesia"] }),
			},
			{
				type: "human.handoff",
				payload: expect.objectContaining({ task: "Complete the ID check", url: "https://example.com/verify" }),
			},
		]);
		expect(requests[2].payload).not.toHaveProperty("why");
	});
});
