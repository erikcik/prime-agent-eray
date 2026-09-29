import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledPurchaseSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "purchase");
	return {
		name: "purchase",
		importName: "purchase",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("purchase skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-purchase-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips request, code and budget, and masks the card when printed", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledPurchaseSkill()],
			hostHandlers: {
				"purchase.request": async (payload) => {
					requests.push({ type: "purchase.request", payload });
					return payload.merchant === "Namecheap"
						? {
								id: "p1",
								approved: true,
								remaining: 288,
								card: { number: "4111111111111111", expiry: "12/29", cvc: "123", name: null },
							}
						: { id: "p2", approved: false, remaining: 288, reason: "use the free tier first" };
				},
				"purchase.code": async (payload) => {
					requests.push({ type: "purchase.code", payload });
					return { code: "482913" };
				},
				"purchase.budget": async () => ({ budget: 300, currency: "USD", spent: 12, remaining: 288, history: [] }),
			},
		});

		const manager = await provisioner.ensure();
		const approved = await manager.execute(`
_d = await purchase.request(12, merchant="Namecheap", description="domain", expected_outcome="landing page")
print(_d.approved, _d.remaining, _d.card)
print(_d.card.number, _d.card.cvc)
print(await purchase.code(_d.id, prompt="SMS from the bank"))
`);
		expect(approved.status).toBe("ok");
		expect(approved.stdout.trim().split("\n")).toEqual([
			"True 288.0 Card(****1111, exp 12/29)",
			"4111111111111111 123",
			"482913",
		]);

		const rejected = await manager.execute(`
_r = await purchase.request(49.99, merchant="Apollo", description="leads export")
print(_r.approved, _r.reason, _r.card)
print((await purchase.budget())["remaining"])
`);
		expect(rejected.status).toBe("ok");
		expect(rejected.stdout.trim().split("\n")).toEqual(["False use the free tier first None", "288"]);

		expect(requests).toEqual([
			{
				type: "purchase.request",
				payload: expect.objectContaining({
					amount: 12,
					merchant: "Namecheap",
					description: "domain",
					expected_outcome: "landing page",
				}),
			},
			{ type: "purchase.code", payload: expect.objectContaining({ id: "p1", prompt: "SMS from the bank" }) },
			{
				type: "purchase.request",
				payload: expect.objectContaining({ amount: 49.99, merchant: "Apollo", description: "leads export" }),
			},
		]);
		expect(requests[0].payload).not.toHaveProperty("url");
	});
});
