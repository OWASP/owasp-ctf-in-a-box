// #570: the classic module's denominator counts only story steps the viewer's
// team can REACH, and the profile says so — with the count of what is still
// locked. The disclaimer is gated on `locked > 0`: an unlocked event (or one
// with no stories at all) must not carry a note about steps it has no locked
// steps of, and the solved/total pair beside it must stay exactly what it was.
//
// Same harness shape as `page.test.tsx` — renderToStaticMarkup of the real
// Server Component, with the stores it reads stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  getSession,
  getUser,
  getViewerHints,
  moduleLive,
  getResolvedModules,
  getClassicTotals,
  listChallenges,
  listStories,
  getViewerClassic,
  getTeamClassicSolvedIds,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  getViewerHints: vi.fn(),
  moduleLive: vi.fn(),
  getResolvedModules: vi.fn(),
  getClassicTotals: vi.fn(),
  listChallenges: vi.fn(),
  listStories: vi.fn(),
  getViewerClassic: vi.fn(),
  getTeamClassicSolvedIds: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => moduleLive(id)),
);
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/leaderboard/source", () => ({
  getLeaderboardSource: async () => ({ getUser, getLeaderboard: vi.fn() }),
}));
vi.mock("@/lib/team-store", () => ({
  getViewerTeam: async () => null,
  listTeams: async () => [],
  resolveTeamMaxMembers: async () => 4,
  TEAM_MAX_MEMBERS: 4,
  TEAM_WRITES_ENABLED: false,
}));
vi.mock("@/lib/hint-store", () => ({ getViewerHints, HINTS_AVAILABLE: true }));
vi.mock("@/lib/hint-config", () => ({ getHintPenalties: vi.fn(), HINTS_AVAILABLE: true }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals: async () => new Map(),
  listQuestions: async () => [],
  getViewerQuiz: async () => ({ answered: {}, attempts: {} }),
}));
vi.mock("@/lib/ai-store", () => ({
  getAiTotals: async () => new Map(),
  listAiChallenges: async () => [],
  getViewerAi: async () => ({ solved: {}, attempts: {} }),
}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: vi.fn() }));
// Only the classic slice matters here; every other module is switched off
// through `moduleLive` above and its reads are never reached.
vi.mock("@/lib/classic-store", () => ({
  getClassicTotals,
  getTeamClassicTotalsBatch: vi.fn(),
  listChallenges,
  listStories,
  getViewerClassic,
}));
vi.mock("@/lib/classic-team", () => ({ getTeamClassicSolvedIds }));

import ProfilePage from "@/app/(site)/profile/page";

const DISCLAIMER = "Totals count unlocked challenges only";

const CHALLENGES = [
  { id: "step-1", title: "Step One", category: "Web", description: "", points: 10, order: 0 },
  { id: "step-2", title: "Step Two", category: "Web", description: "", points: 50, order: 1 },
  { id: "step-3", title: "Step Three", category: "Web", description: "", points: 90, order: 2 },
];
const STORY = { id: "s1", title: "Operation", intro: "", steps: ["step-1", "step-2", "step-3"] };

/** The page's own reads, for a viewer whose team has solved `solvedIds`. */
function givenTeam(solvedIds: readonly string[], classicPoints: number, classicSolved: number) {
  moduleLive.mockImplementation((id: string) => id === "classic");
  getSession.mockResolvedValue({ user: { login: "ada", image: null } });
  getUser.mockResolvedValue({ points: 0, maxPoints: 0, patched: 0, failed: 0, total: 0 });
  getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
  getResolvedModules.mockResolvedValue([
    { id: "classic", nav: { href: "/challenges", label: "Challenges" }, targets: [], title: "Classic", blurb: "" },
  ]);
  listChallenges.mockResolvedValue(CHALLENGES);
  listStories.mockResolvedValue([STORY]);
  getClassicTotals.mockResolvedValue(new Map([["ada", { points: classicPoints, solved: classicSolved, lastAt: null }]]));
  getViewerClassic.mockResolvedValue({
    solved: Object.fromEntries(solvedIds.map((id) => [id, { points: 10, at: "t" }])),
    attempts: {},
  });
  getTeamClassicSolvedIds.mockResolvedValue(new Set(solvedIds));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the profile's story-lock disclaimer (#570)", () => {
  it("shows the disclaimer and the locked-step count while steps are locked", async () => {
    // Only step one is solved: step two is reachable through it, step three
    // is not — 1 solved, 2 reachable, 1 locked.
    givenTeam(["step-1"], 10, 1);

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).toContain(DISCLAIMER);
    expect(html).toContain("· 1 steps locked");
    // The denominator is the REACHABLE count (2), never the full catalogue (3)…
    expect(html).toContain("/ 2 solved");
    expect(html).not.toContain("/ 3 solved");
    // …and so is the points ceiling: step three's 90 pts are not on offer yet.
    expect(html).toContain("10 of 60 pts available");
    // The locked step's title never reaches the page (#463, carried through).
    expect(html).not.toContain("Step Three");
  });

  it("says nothing once every step is reachable, and keeps solved/total as it was", async () => {
    givenTeam(["step-1", "step-2", "step-3"], 150, 3);

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).not.toContain(DISCLAIMER);
    expect(html).not.toContain("steps locked");
    expect(html).toContain("/ 3 solved");
    // The whole story is on offer now: 10 + 50 + 90.
    expect(html).toContain("150 of 150 pts available");
  });
});
