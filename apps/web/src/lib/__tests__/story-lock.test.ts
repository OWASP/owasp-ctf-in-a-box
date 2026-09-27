// Stories (#463): which step is locked is DERIVED from the team's current
// solves on every read — nothing records an unlock.
import { describe, expect, it } from "vitest";
import { isLocked, storyPositions, type Story } from "@/lib/story-lock";

const op: Story = { id: "operation-ctf", title: "Operation CTF", intro: "", steps: ["recon", "web", "crypto"] };
const two: Story = { id: "side", title: "Side quest", intro: "", steps: ["a", "b"] };

describe("storyPositions", () => {
  it("places each step with its 1-based position, total and prerequisite", () => {
    const pos = storyPositions([op, two]);
    expect(pos.get("recon")).toEqual({ storyId: "operation-ctf", position: 1, total: 3, prereq: null });
    expect(pos.get("web")).toEqual({ storyId: "operation-ctf", position: 2, total: 3, prereq: "recon" });
    expect(pos.get("crypto")).toEqual({ storyId: "operation-ctf", position: 3, total: 3, prereq: "web" });
    expect(pos.get("b")).toEqual({ storyId: "side", position: 2, total: 2, prereq: "a" });
    expect(pos.has("free-pick")).toBe(false);
  });
});

describe("isLocked", () => {
  const pos = storyPositions([op]);
  it("never locks step 1", () => {
    expect(isLocked(pos.get("recon")!, new Set())).toBe(false);
  });
  it("locks a step until the team has solved the one before it", () => {
    expect(isLocked(pos.get("web")!, new Set())).toBe(true);
    expect(isLocked(pos.get("web")!, new Set(["recon"]))).toBe(false);
  });
  it("only the IMMEDIATE predecessor counts — solving step 1 does not open step 3", () => {
    expect(isLocked(pos.get("crypto")!, new Set(["recon"]))).toBe(true);
    expect(isLocked(pos.get("crypto")!, new Set(["recon", "web"]))).toBe(false);
  });
});
