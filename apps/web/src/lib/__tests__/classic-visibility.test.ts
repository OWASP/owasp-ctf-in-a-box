// classicVisibility (#186) is the ONE answer to "may this viewer see classic
// challenge X": the detail page, its metadata and the attachment download
// route all ask it, so a lock added here reaches every one of them.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  live: true,
  access: { allowed: true, preview: false },
  admins: new Set<string>(),
  teamed: new Set<string>(),
  challenges: [{ id: "one" }, { id: "two" }] as { id: string }[],
  stories: [] as { id: string; title: string; intro: string; steps: string[] }[],
  solved: new Set<string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: async () => m.live }));
vi.mock("@/lib/launch", () => ({ getLaunchAccess: async () => m.access }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin: async (l?: string) => !!l && m.admins.has(l) }));
vi.mock("@/lib/team-store", () => ({ hasTeam: async (l: string) => m.teamed.has(l) }));
vi.mock("@/lib/classic-store", () => ({
  listChallenges: async () => m.challenges,
  listStories: async () => m.stories,
}));
vi.mock("@/lib/classic-team", () => ({ getTeamClassicSolvedIds: async () => m.solved }));

import { classicVisibility } from "@/lib/classic-visibility";

beforeEach(() => {
  m.live = true;
  m.access = { allowed: true, preview: false };
  m.admins = new Set();
  m.teamed = new Set(["alice"]);
  m.stories = [];
  m.solved = new Set();
});

describe("classicVisibility", () => {
  it("is visible for a teamed contestant on a launched event", async () => {
    expect(await classicVisibility("alice", "one")).toEqual({ state: "visible", preview: false });
  });

  it("is visible to a signed-out visitor, as the page is", async () => {
    expect((await classicVisibility(undefined, "one")).state).toBe("visible");
  });

  it("names each lock, in the page's order", async () => {
    m.live = false;
    expect((await classicVisibility("alice", "one")).state).toBe("module-off");
    m.live = true;
    m.access = { allowed: false, preview: false };
    expect((await classicVisibility("alice", "one")).state).toBe("not-launched");
    m.access = { allowed: true, preview: false };
    expect((await classicVisibility("bob", "one")).state).toBe("teamless");
    expect((await classicVisibility("alice", "nope")).state).toBe("missing");
    m.stories = [{ id: "op", title: "Op", intro: "", steps: ["one", "two"] }];
    expect((await classicVisibility("alice", "two")).state).toBe("locked");
    // Not vacuous: the same step opens once the team solves its predecessor.
    m.solved = new Set(["one"]);
    expect((await classicVisibility("alice", "two")).state).toBe("visible");
  });

  it("lets a teamless admin through, and an admin preview skips the story lock", async () => {
    m.admins = new Set(["boss"]);
    expect((await classicVisibility("boss", "one")).state).toBe("visible");
    m.access = { allowed: true, preview: true };
    m.stories = [{ id: "op", title: "Op", intro: "", steps: ["one", "two"] }];
    expect(await classicVisibility("boss", "two")).toEqual({ state: "visible", preview: true });
  });
});
