import { describe, expect, it } from "vitest";
import { type FlatTreeNode, rewindPointsForBranch } from "../src/server/daemon/rewind.ts";

function user(id: string, parentId: string | null, text: string): FlatTreeNode {
	return { entry: { id, parentId, type: "message", message: { role: "user", content: [{ type: "text", text }] } } };
}
function assistant(id: string, parentId: string | null): FlatTreeNode {
	return { entry: { id, parentId, type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } };
}

describe("rewindPointsForBranch", () => {
	it("lists only user messages, oldest first, on the current branch", () => {
		const nodes = [user("u1", null, "first"), assistant("a1", "u1"), user("u2", "a1", "second"), assistant("a2", "u2")];
		const points = rewindPointsForBranch(nodes, "a2");
		expect(points.map((p) => p.entryId)).toEqual(["u1", "u2"]);
		expect(points.map((p) => p.index)).toEqual([0, 1]);
		expect(points[1]?.text).toBe("second");
	});

	it("excludes messages on abandoned branches", () => {
		// u1 -> a1 -> u2 (abandoned)  and  u1 -> a1 -> u3 -> a3 (current leaf)
		const nodes = [user("u1", null, "first"), assistant("a1", "u1"), user("u2", "a1", "abandoned"), user("u3", "a1", "retry"), assistant("a3", "u3")];
		const points = rewindPointsForBranch(nodes, "a3");
		expect(points.map((p) => p.entryId)).toEqual(["u1", "u3"]);
	});

	it("skips empty user messages and tolerates a missing leaf", () => {
		const nodes = [user("u1", null, "   "), user("u2", "u1", "real")];
		expect(rewindPointsForBranch(nodes, "u2").map((p) => p.entryId)).toEqual(["u2"]);
		expect(rewindPointsForBranch(nodes, null)).toEqual([]);
		expect(rewindPointsForBranch(nodes, "nope")).toEqual([]);
	});

	it("survives a parent cycle", () => {
		const nodes = [user("u1", "u2", "a"), user("u2", "u1", "b")];
		expect(rewindPointsForBranch(nodes, "u2")).toHaveLength(2);
	});
});
