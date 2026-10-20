// A hidden Jeopardy challenge does not exist on /flags: it is left out of the
// SERVER payload — the props the page hands its client components — not
// merely not rendered. Asserted on those props, never on markup, so a view
// model that carried the challenge and a component that happened to skip it
// would still fail here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({
  challenges: [] as Record<string, unknown>[],
  stories: [] as { id: string; title: string; intro: string; steps: string[] }[],
  hintIds: [] as string[],
  teamSolved: new Set<string>(),
  board: { challenges: [] as Record<string, unknown>[], runExtras: [] as Record<string, unknown>[], hintIds: [] as string[] },
  lanes: [] as { steps: Record<string, unknown>[] }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/launch", () => ({ redirectIfNotLaunched: async () => ({ allowed: true, preview: false }) }));
vi.mock("@/lib/enabled-modules", async () => (await import("@/test/enabled-modules-mock")).mockEnabledModules(() => true));
vi.mock("@/lib/admin-admins", () => ({ listStoredAdmins: async () => [] }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin: async () => false }));
vi.mock("@/lib/require-team", () => ({ redirectIfTeamless: async () => false }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules: async () => [{ id: "classic", title: "Jeopardy", blurb: "b" }] }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { login: "alice" } }) } } }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: async () => ({ classicCooldownSec: 5 }) }));
vi.mock("@/lib/hint-store", () => ({ getClassicHintIds: async () => m.hintIds }));
vi.mock("@/lib/team-solve-counts", () => ({
  teamSolveBoard: async () => ({
    counts: new Map(m.challenges.map((c) => [c.id as string, 2])),
    firstBlood: new Map(m.challenges.map((c) => [c.id as string, { login: "first-solver", at: null }])),
  }),
}));
vi.mock("@/lib/classic-team", () => ({ getTeamClassicSolvedIds: async () => m.teamSolved, storyLockLua: () => "" }));
vi.mock("@/lib/classic-store", () => ({
  listStories: async () => m.stories,
  listChallenges: async () => m.challenges,
  listCategories: async () => ["Web"],
  getViewerClassic: async () => ({ solved: { gone: { points: 10, at: "2026-10-01T00:00:00.000Z" } }, attempts: {} }),
  CLASSIC_COOLDOWN_SEC: 5,
}));
vi.mock("@/components/challenge-board", () => ({
  default: (props: typeof m.board) => {
    m.board = props;
    return null;
  },
}));
vi.mock("@/components/story-lanes", () => ({
  default: (props: { stories: typeof m.lanes }) => {
    m.lanes = props.stories;
    return null;
  },
}));

import FlagsPage from "@/app/(site)/flags/page";

const SECRET_TITLE = "Unreleased-title-zz41";
const c = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id === "gone" ? SECRET_TITLE : id,
  category: "Web",
  description: "d",
  points: 10,
  order: 0,
  ...over,
});

beforeEach(() => {
  m.stories = [];
  m.hintIds = [];
  m.teamSolved = new Set();
  m.lanes = [];
});

describe("/flags and a hidden challenge", () => {
  it("leaves a disabled challenge out of the board payload, with its count, first blood and hint marker", async () => {
    m.challenges = [c("open"), c("gone", { enabled: false })];
    m.hintIds = ["open", "gone"];
    renderToStaticMarkup(await FlagsPage());
    // Non-vacuous: the visible one did reach the board.
    expect(m.board.challenges.map((v) => v.id)).toEqual(["open"]);
    expect(m.board.hintIds).toEqual(["open"]);
    const payload = JSON.stringify({ board: m.board, lanes: m.lanes });
    expect(payload).not.toContain("gone");
    expect(payload).not.toContain(SECRET_TITLE);
  });

  it("hides it from a contestant who already solved it too", async () => {
    // getViewerClassic above reports `gone` solved by this viewer.
    m.challenges = [c("open"), c("gone", { enabled: false })];
    renderToStaticMarkup(await FlagsPage());
    expect(JSON.stringify(m.board)).not.toContain(SECRET_TITLE);
  });

  it("closes a story's chain around a hidden step, and reopens it in order", async () => {
    m.stories = [{ id: "op", title: "Op", intro: "", steps: ["one", "gone", "three"] }];
    m.teamSolved = new Set(["one"]);
    m.challenges = [c("one"), c("gone", { enabled: false }), c("three")];
    renderToStaticMarkup(await FlagsPage());
    const steps = m.lanes[0].steps;
    expect(steps).toHaveLength(2);
    // Step 2 of 2 now, open because step 1 is solved.
    expect(steps[1]).toMatchObject({ locked: false, id: "three", position: 2, total: 2 });
    expect(JSON.stringify(m.lanes)).not.toContain(SECRET_TITLE);

    m.challenges = [c("one"), c("gone"), c("three")];
    renderToStaticMarkup(await FlagsPage());
    expect(m.lanes[0].steps).toHaveLength(3);
    expect(m.lanes[0].steps[1]).toMatchObject({ locked: false, id: "gone", position: 2, total: 3 });
    expect(m.lanes[0].steps[2]).toMatchObject({ locked: true });
  });
  it("keeps a challenge off the board until its release time, and shows it from then on", async () => {
    m.challenges = [c("open"), c("gone", { enabled: false, releaseAt: new Date(Date.now() + 3_600_000).toISOString() })];
    renderToStaticMarkup(await FlagsPage());
    expect(JSON.stringify(m.board)).not.toContain(SECRET_TITLE);
    m.challenges = [c("open"), c("gone", { enabled: false, releaseAt: new Date(Date.now() - 1_000).toISOString() })];
    renderToStaticMarkup(await FlagsPage());
    expect(m.board.challenges.map((v) => v.id)).toEqual(["open", "gone"]);
  });
});
