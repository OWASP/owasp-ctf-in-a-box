// classicVisibility (#186) is the ONE answer to "may this viewer see classic
// challenge X": the detail page, its metadata and the attachment download
// route all ask it, so a lock added here reaches every one of them.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  live: true,
  access: { allowed: true, preview: false },
  admins: new Set<string>(),
  teamed: new Set<string>(),
  challenges: [{ id: "one" }, { id: "two" }] as { id: string; enabled?: boolean; releaseAt?: string }[],
  stories: [] as { id: string; title: string; intro: string; steps: string[] }[],
  solved: new Set<string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: async () => m.live }));
vi.mock("@/lib/launch", () => ({ getLaunchAccess: async () => m.access }));
vi.mock("@/lib/admin-auth", () => ({ isAdminPlayer: async (l?: string) => !!l && m.admins.has(l) }));
vi.mock("@/lib/team-store", () => ({ hasTeam: async (l: string) => m.teamed.has(l) }));
vi.mock("@/lib/classic-store", () => ({
  listChallenges: async () => m.challenges,
  listStories: async () => m.stories,
}));
vi.mock("@/lib/classic-team", () => ({ getTeamClassicSolvedIds: async () => m.solved }));

import { adminSeesHidden, classicVisibility } from "@/lib/classic-visibility";

// The player id keys the team, the solves and the admin check.
const as = (name: string) => ({ id: `${name}-id` });

beforeEach(() => {
  m.live = true;
  m.access = { allowed: true, preview: false };
  m.admins = new Set();
  m.teamed = new Set(["alice-id"]);
  m.stories = [];
  m.solved = new Set();
  m.challenges = [{ id: "one" }, { id: "two" }];
});

describe("classicVisibility", () => {
  it("is visible for a teamed contestant on a launched event", async () => {
    expect(await classicVisibility(as("alice"), "one")).toEqual({ state: "visible", preview: false });
  });

  it("is visible to a signed-out visitor, as the page is", async () => {
    expect((await classicVisibility(null, "one")).state).toBe("visible");
  });

  it("names each lock, in the page's order", async () => {
    m.live = false;
    expect((await classicVisibility(as("alice"), "one")).state).toBe("module-off");
    m.live = true;
    m.access = { allowed: false, preview: false };
    expect((await classicVisibility(as("alice"), "one")).state).toBe("not-launched");
    m.access = { allowed: true, preview: false };
    expect((await classicVisibility(as("bob"), "one")).state).toBe("teamless");
    expect((await classicVisibility(as("alice"), "nope")).state).toBe("missing");
    m.stories = [{ id: "op", title: "Op", intro: "", steps: ["one", "two"] }];
    expect((await classicVisibility(as("alice"), "two")).state).toBe("locked");
    // Not vacuous: the same step opens once the team solves its predecessor.
    m.solved = new Set(["one"]);
    expect((await classicVisibility(as("alice"), "two")).state).toBe("visible");
  });

  it("lets a teamless admin through, and an admin preview skips the story lock", async () => {
    m.admins = new Set(["boss-id"]);
    expect((await classicVisibility(as("boss"), "one")).state).toBe("visible");
    m.access = { allowed: true, preview: true };
    m.stories = [{ id: "op", title: "Op", intro: "", steps: ["one", "two"] }];
    expect(await classicVisibility(as("boss"), "two")).toEqual({ state: "visible", preview: true });
  });
});

// A hidden challenge does not exist for a contestant: the page, its metadata
// and the attachment route all get `missing`, the answer an unknown id gets.
describe("classicVisibility and hidden challenges", () => {
  it("answers missing for a disabled challenge, exactly like an unknown id", async () => {
    m.challenges = [{ id: "one", enabled: false }, { id: "two" }];
    expect(await classicVisibility(as("alice"), "one")).toEqual(await classicVisibility(as("alice"), "nope"));
    expect((await classicVisibility(null, "one")).state).toBe("missing");
  });

  it("opens it to an admin after launch, marked with why contestants cannot see it", async () => {
    m.admins = new Set(["boss-id"]);
    m.challenges = [{ id: "one", enabled: false }];
    expect(await classicVisibility(as("boss"), "one")).toEqual({ state: "visible", preview: false, hidden: { kind: "disabled" } });
    const releaseAt = new Date(Date.now() + 3_600_000).toISOString();
    m.challenges = [{ id: "one", enabled: false, releaseAt }];
    expect((await classicVisibility(as("boss"), "one")).hidden).toEqual({ kind: "scheduled", releaseAt });
    // A live challenge carries no mark.
    m.challenges = [{ id: "one" }];
    expect(await classicVisibility(as("boss"), "one")).toEqual({ state: "visible", preview: false });
  });

  it("lets an admin preview open a disabled challenge", async () => {
    m.admins = new Set(["boss-id"]);
    m.access = { allowed: true, preview: true };
    m.challenges = [{ id: "one", enabled: false }];
    expect(await classicVisibility(as("boss"), "one")).toEqual({ state: "visible", preview: true, hidden: { kind: "disabled" } });
  });

  it("closes a story chain around a hidden step, and reopens it in order when the step returns", async () => {
    m.stories = [{ id: "op", title: "Op", intro: "", steps: ["one", "two", "three"] }];
    m.challenges = [{ id: "one" }, { id: "two", enabled: false }, { id: "three" }];
    m.solved = new Set(["one"]);
    expect((await classicVisibility(as("alice"), "three")).state).toBe("visible");
    m.challenges = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect((await classicVisibility(as("alice"), "three")).state).toBe("locked");
    expect((await classicVisibility(as("alice"), "two")).state).toBe("visible");
  });
  it("answers missing before a release time and visible after it", async () => {
    m.challenges = [{ id: "one", enabled: false, releaseAt: new Date(Date.now() + 3_600_000).toISOString() }];
    expect((await classicVisibility(as("alice"), "one")).state).toBe("missing");
    m.challenges = [{ id: "one", enabled: false, releaseAt: new Date(Date.now() - 1_000).toISOString() }];
    expect((await classicVisibility(as("alice"), "one")).state).toBe("visible");
  });
});

describe("adminSeesHidden", () => {
  it("is true only for an admin and a challenge that exists and is hidden now", async () => {
    m.admins = new Set(["boss-id"]);
    m.challenges = [{ id: "off", enabled: false }, { id: "on" }];
    expect(await adminSeesHidden("boss-id", "off")).toBe(true);
    expect(await adminSeesHidden("boss-id", "on")).toBe(false);
    expect(await adminSeesHidden("boss-id", "nope")).toBe(false);
    expect(await adminSeesHidden("alice", "off")).toBe(false);
  });
});
