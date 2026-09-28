// #463: the profile's classic list must not reveal a locked story step —
// review C1 found it listed every challenge's title and points.
import { describe, expect, it } from "vitest";
import { moduleItemsFor } from "@/app/(site)/profile/module-blocks";

const challenges = [
  { id: "recon", title: "Recon", category: "Web", description: "", points: 10, order: 0 },
  { id: "secret", title: "Secret SQLi", category: "Web", description: "", points: 50, order: 1 },
];

describe("moduleItemsFor classic with locked story steps", () => {
  it("leaves every locked step out of the list", () => {
    // Only the classic slice matters to this branch; the rest of the input is irrelevant here.
    const input = {
      classic: { challenges, maxPoints: 60, viewer: { solved: { recon: { points: 10, at: "x" } }, attempts: {} }, locked: new Set(["secret"]) },
    } as unknown as Parameters<typeof moduleItemsFor>[1];
    const list = moduleItemsFor("classic", input);
    const names = list?.items.map((i) => i.name) ?? [];
    expect(names).toContain("Recon");
    expect(JSON.stringify(list)).not.toContain("Secret SQLi");
  });
});

// CodeRabbit #470: the classic ceiling (row max, "still winnable", overall
// progress) counted locked steps' points — a locked step's value leaked.
describe("visibleClassic", () => {
  it("drops locked steps from the challenge list AND the points ceiling", async () => {
    const { visibleClassic } = await import("@/app/(site)/profile/module-blocks");
    const v = visibleClassic(challenges, new Set(["secret"]));
    expect(v.challenges.map((c) => c.id)).toEqual(["recon"]);
    expect(v.maxPoints).toBe(10);
    expect(visibleClassic(challenges, new Set()).maxPoints).toBe(60);
  });
});
