// #570: the classic module's denominator counts only story steps the viewer's
// team can REACH, and the profile says so — with the count of what is still
// locked. The disclaimer is gated on `locked > 0`: an unlocked event (or one
// with no stories at all) must not carry a note about steps it has no locked
// steps of, and the solved/total pair beside it must stay exactly what it was.
// One test also pins the parity rule behind that denominator: the
// solved-id set and the point records come from ONE roster fold, so a
// teammate's deleted solve counts in the ceiling exactly as the viewer's own.
//
// Same harness shape as `page.test.tsx` — renderToStaticMarkup of the real
// Server Component, with the stores it reads stubbed. A teamed fixture
// carries a store roster (the fold reads one); the teamless fixture pins
// that no roster means no unlock past step 1, while the viewer's own banked
// records still feed the denominator's union.
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
  getTeamClassicTotalsBatch,
  getViewerTeam,
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
  getTeamClassicTotalsBatch: vi.fn(),
  getViewerTeam: vi.fn(),
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
  getViewerTeam,
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
  getTeamClassicTotalsBatch,
  listChallenges,
  listStories,
  getViewerClassic,
}));

import ProfilePage from "@/app/(site)/profile/page";

const DISCLAIMER = "Totals count unlocked challenges only";

const CHALLENGES = [
  { id: "step-1", title: "Step One", category: "Web", description: "", points: 10, order: 0 },
  { id: "step-2", title: "Step Two", category: "Web", description: "", points: 50, order: 1 },
  { id: "step-3", title: "Step Three", category: "Web", description: "", points: 90, order: 2 },
];
const STORY = { id: "s1", title: "Operation", intro: "", steps: ["step-1", "step-2", "step-3"] };

/** A second, independent chain — so a fixture can hold more than one locked
 *  step and pin the plural form of the marker. */
const CHAIN2 = [
  { id: "beta-1", title: "Beta One", category: "Web", description: "", points: 20, order: 3 },
  { id: "beta-2", title: "Beta Two", category: "Web", description: "", points: 40, order: 4 },
];
const STORY2 = { id: "s2", title: "Second Operation", intro: "", steps: ["beta-1", "beta-2"] };

/** The page's own reads, for a viewer whose team has solved `solvedIds`. */
function givenTeam(solvedIds: readonly string[], classicPoints: number, classicSolved: number) {
  moduleLive.mockImplementation((id: string) => id === "classic");
  getSession.mockResolvedValue({ user: { login: "ada", image: null } });
  getUser.mockResolvedValue({ points: 0, maxPoints: 0, patched: 0, failed: 0, total: 0 });
  getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
  getResolvedModules.mockResolvedValue([
    { id: "classic", nav: { href: "/challenges", label: "Challenges" }, targets: [], title: "Classic", blurb: "" },
  ]);
  // The fold reads the STORE team's roster, so a fixture standing in for a
  // teamed viewer has to carry one — a viewer with no store team reaches the
  // teamless path instead (pinned in its own test below).
  getViewerTeam.mockResolvedValue({ slug: "red", name: "Red", members: ["ada"] });
  listChallenges.mockResolvedValue(CHALLENGES);
  listStories.mockResolvedValue([STORY]);
  getClassicTotals.mockResolvedValue(new Map([["ada", { points: classicPoints, solved: classicSolved, lastAt: null }]]));
  getViewerClassic.mockResolvedValue({
    solved: Object.fromEntries(solvedIds.map((id) => [id, { points: 10, at: "t" }])),
    attempts: {},
  });
  getTeamClassicTotalsBatch.mockResolvedValue([
    {
      points: classicPoints,
      solved: classicSolved,
      lastAt: null,
      itemIds: [...solvedIds],
      itemPoints: Object.fromEntries(solvedIds.map((id) => [id, 10])),
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: the team must default back to
  // teamless so a test that gives the viewer a team can't leak into the next.
  getViewerTeam.mockResolvedValue(null);
});

/** The same viewer, on an event with two independent stories. */
function givenTwoChains(solvedIds: readonly string[]) {
  givenTeam(solvedIds, 10, 1);
  listChallenges.mockResolvedValue([...CHALLENGES, ...CHAIN2]);
  listStories.mockResolvedValue([STORY, STORY2]);
}

describe("the profile's story-lock disclaimer (#570)", () => {
  it("shows the disclaimer and the locked-step count while steps are locked", async () => {
    // Only step one is solved: step two is reachable through it, step three
    // is not — 1 solved, 2 reachable, 1 locked.
    givenTeam(["step-1"], 10, 1);

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).toContain(DISCLAIMER);
    expect(html).toContain("· 1 step locked");
    // The denominator is the REACHABLE count (2), never the full catalogue (3)…
    expect(html).toContain("/ 2 solved");
    expect(html).not.toContain("/ 3 solved");
    // …and so is the points ceiling: step three's 90 pts are not on offer yet.
    expect(html).toContain("10 of 60 pts available");
    // The locked step's title never reaches the page (#463, carried through).
    expect(html).not.toContain("Step Three");
  });

  // The marker and the denominator both come from ONE locked figure across
  // every story on the event, so a second chain must add to both rather than
  // overwrite the first.
  it("counts locked steps across every story and names none of them", async () => {
    // step-1 solved: step-2 opens through it, step-3 stays locked; beta-1 is
    // step 1 of its own chain, beta-2 stays locked. 3 reachable, 2 locked.
    givenTwoChains(["step-1"]);

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).toContain(DISCLAIMER);
    expect(html).toContain("· 2 steps locked");
    expect(html).toContain("/ 3 solved");
    expect(html).not.toContain("/ 5 solved");
    // 10 + 50 + 20 reachable; the two locked steps' 90 and 40 never offered.
    expect(html).toContain("10 of 80 pts available");
    expect(html).not.toContain("Step Three");
    expect(html).not.toContain("Beta Two");
    // Titles of steps the viewer CAN reach still render.
    expect(html).toContain("Beta One");
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

  // The denominator's two inputs must leave ONE roster fold: the solved-id set
  // that unlocks steps and the per-item points the ceiling counts. Pairing a
  // team-wide id set with only the viewer's own records leaves a teammate's
  // solve of a since-deleted challenge in the count with no points behind it —
  // the profile then advertises a ceiling missing banked team points. Locked
  // titles and points stay off the page either way (#463).
  it("folds a teammate's deleted solve into the ceiling at its solve-time points", async () => {
    moduleLive.mockImplementation((id: string) => id === "classic");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({ points: 0, maxPoints: 0, patched: 0, failed: 0, total: 0 });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getResolvedModules.mockResolvedValue([
      { id: "classic", nav: { href: "/challenges", label: "Challenges" }, targets: [], title: "Classic", blurb: "" },
    ]);
    // The roster resolves once, off the store team this page already read.
    getViewerTeam.mockResolvedValue({ slug: "red", name: "Red", members: ["ada", "grace"] });
    listChallenges.mockResolvedValue(CHALLENGES);
    listStories.mockResolvedValue([STORY]);
    getClassicTotals.mockResolvedValue(new Map([["ada", { points: 10, solved: 1, lastAt: null }]]));
    getViewerClassic.mockResolvedValue({ solved: { "step-1": { points: 10, at: "t" } }, attempts: {} });
    // grace solved step-1 (unlocking step-2 for the team) and gone-1 — a
    // challenge since deleted from the catalogue, banked at 70 pts.
    getTeamClassicTotalsBatch.mockResolvedValue([
      {
        points: 80,
        solved: 2,
        lastAt: null,
        itemIds: ["step-1", "gone-1"],
        itemPoints: { "step-1": 10, "gone-1": 70 },
      },
    ]);

    const html = renderToStaticMarkup(await ProfilePage());

    // One team read, and the fold is handed exactly that roster.
    expect(getViewerTeam).toHaveBeenCalledTimes(1);
    expect(getTeamClassicTotalsBatch).toHaveBeenCalledWith([["ada", "grace"]]);
    // The ceiling carries the teammate's deleted solve at its solve-time
    // points: step-1 (10) + step-2 (50) + gone-1 (70) = 130 — count and
    // ceiling agree because they come from the same fold. A fold handed
    // team-wide ids but viewer-only records advertises 60 here.
    expect(html).toContain("10 of 130 pts available");
    expect(html).not.toContain("10 of 60 pts available");
    expect(html).toContain("/ 3 solved");
    expect(html).toContain("/ 130 pts");
    expect(html).toContain(DISCLAIMER);
    expect(html).toContain("· 1 step locked");
    // step-3 stays unreachable behind the fold: neither its title nor its
    // 90 pts reach the page (nothing else on it renders those digits).
    expect(html).not.toContain("Step Three");
    expect(html).not.toContain("90 pts");
  });

  // Story unlock is a TEAM property. A viewer with no store team must not
  // fold as a "team of one" — that let a solve banked before leaving a team
  // unlock the next step for the lone contestant alone. Their OWN banked
  // records still feed the union (a since-deleted challenge keeps its points
  // in the ceiling), and no team fold read is issued at all.
  it("keeps later steps locked for a teamless viewer, preserving their banked points", async () => {
    moduleLive.mockImplementation((id: string) => id === "classic");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({ points: 0, maxPoints: 0, patched: 0, failed: 0, total: 0 });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getResolvedModules.mockResolvedValue([
      { id: "classic", nav: { href: "/challenges", label: "Challenges" }, targets: [], title: "Classic", blurb: "" },
    ]);
    // No team (beforeEach's default). The viewer's OWN records hold step-1
    // and gone-1 — a challenge since deleted, banked at 70 pts.
    listChallenges.mockResolvedValue(CHALLENGES);
    listStories.mockResolvedValue([STORY]);
    getClassicTotals.mockResolvedValue(new Map([["ada", { points: 80, solved: 2, lastAt: null }]]));
    getViewerClassic.mockResolvedValue({
      solved: { "step-1": { points: 10, at: "t" }, "gone-1": { points: 70, at: "t" } },
      attempts: {},
    });

    const html = renderToStaticMarkup(await ProfilePage());

    // Nothing to fold: the team batch read is skipped entirely.
    expect(getViewerTeam).toHaveBeenCalledTimes(1);
    expect(getTeamClassicTotalsBatch).not.toHaveBeenCalled();
    // Reachability is empty, so step-2 (behind step-1's solo solve) and
    // step-3 (behind step-2) both stay locked — a team-of-one fold would
    // have opened step-2 and reported one locked step.
    expect(html).toContain(DISCLAIMER);
    expect(html).toContain("· 2 steps locked");
    // The reachable count is step 1 plus gone-1's identity, never step 2.
    expect(html).toContain("/ 2 solved");
    expect(html).not.toContain("/ 3 solved");
    // Historical points preserved: step-1's 10 and gone-1's solve-time 70
    // stay in the ceiling; the 130 a team-of-one fold would have advertised
    // (adding step-2's 50) never appears.
    expect(html).toContain("80 of 80 pts available");
    expect(html).not.toContain("of 130 pts");
    // Locked-step secrecy: neither locked title reaches the page.
    expect(html).not.toContain("Step Two");
    expect(html).not.toContain("Step Three");
  });
});
