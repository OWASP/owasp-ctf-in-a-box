// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. renderToStaticMarkup (ships with react-dom) is
// enough to check the initial server render — same pattern as
// admin/__tests__/page.test.tsx and quiz/__tests__/page.test.tsx.
//
// The point of this file is I2: the profile page's headline points figure
// must equal what the SAME login's leaderboard row would show — hint spend
// subtracted, quiz points added, in that order. Rather than re-deriving the
// formula by hand (which would pass even if the two implementations quietly
// drifted), this drives the REAL leaderboard overlay functions
// (withHintPenalties, withModuleContributions) on an equivalent entry and
// asserts the profile page renders that exact number.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  getSession,
  getUser,
  getLeaderboard,
  getViewerTeam,
  getViewerHints,
  getHintPenalties,
  isModuleEnabled,
  getQuizTotals,
  listQuestions,
  getAiTotals,
  listAiChallenges,
  getResolvedModules,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  getLeaderboard: vi.fn(),
  getViewerTeam: vi.fn(),
  getViewerHints: vi.fn(),
  getHintPenalties: vi.fn(),
  isModuleEnabled: vi.fn(),
  getQuizTotals: vi.fn(),
  listQuestions: vi.fn(),
  getAiTotals: vi.fn(),
  listAiChallenges: vi.fn(),
  getResolvedModules: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
// TeamCard (rendered unconditionally by the profile page) calls useRouter —
// same reason quiz/__tests__/page.test.tsx mocks it for QuizBoard.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSource: async () => ({ getUser, getLeaderboard }) }));
vi.mock("@/lib/team-store", () => ({
  getViewerTeam,
  // The page renders the cap through the same resolver joinTeam enforces
  // with, so the mock has to provide it (issue #99).
  resolveTeamMaxMembers: async () => 4,
  TEAM_MAX_MEMBERS: 4,
  TEAM_WRITES_ENABLED: false,
}));
vi.mock("@/lib/hint-store", () => ({ getViewerHints, getHintPenalties, HINTS_AVAILABLE: true }));
// Partial mock: `isModuleEnabled` is what this page's gates call, but
// `@/lib/site` reads `SECURE_AGENT_PLAYBOOK_URL` off this same module at
// import time (the registry owns the constant; site.ts re-exports it as
// `event.secureAgentPlaybookUrl`), so a whole-module replacement that omits
// it makes every importer of site.ts throw — same trap `challenges/
// __tests__/page.test.tsx` documents for its own `@/lib/modules` mock.
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled,
}));
// The per-module block list is driven off this, not off `@/lib/modules`
// directly — these tests don't exercise the breakdown blocks, so an empty
// list is enough to keep the page from rendering any.
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals,
  listQuestions,
  // The blocks' Show-N item list reads the viewer's own per-question map.
  getViewerQuiz: async () => ({ answered: {}, attempts: {} }),
}));
vi.mock("@/lib/ai-store", () => ({
  getAiTotals,
  listAiChallenges,
  // The blocks' Show-N item list reads the viewer's own per-challenge map.
  getViewerAi: async () => ({ solved: {}, attempts: {} }),
}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: vi.fn() }));

import ProfilePage from "@/app/(site)/profile/page";
import { withHintPenalties } from "@/lib/leaderboard/hint-penalties";
import { withModuleContributions } from "@/lib/leaderboard/module-contributions";
import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard/types";
import { MIN_FILL_PX } from "@/components/progress/progress-bar";

beforeEach(() => {
  vi.clearAllMocks();
  getViewerTeam.mockResolvedValue(null);
  listQuestions.mockResolvedValue([]);
  listAiChallenges.mockResolvedValue([]);
  getResolvedModules.mockResolvedValue([]);
});

const baseProfile = {
  login: "ada",
  team: null,
  teamName: null,
  points: 40,
  maxPoints: 100,
  patched: 4,
  failed: 0,
  total: 6,
  apps: [] as never[],
  updatedAt: null,
};

describe("profile page points vs. the leaderboard row", () => {
  it("agrees with withHintPenalties + withModuleContributions for the same login (quiz enabled)", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "quiz" || id === "secure-development");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue(baseProfile);
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 10, count: 1 });
    getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 2, lastAt: null }]]));
    getHintPenalties.mockResolvedValue(new Map([["ada", 10]]));

    const html = renderToStaticMarkup(await ProfilePage());

    // Independently compute what the leaderboard would show this SAME login,
    // through the real overlay pipeline (not a hand-rolled formula).
    const entry: LeaderboardEntry = {
      rank: 1,
      login: "ada",
      team: null,
      points: baseProfile.points,
      patched: baseProfile.patched,
      failed: 0,
      total: baseProfile.total,
      apps: {},
      updatedAt: null,
    };
    const data: LeaderboardData = {
      entries: [entry],
      teams: [],
      generatedAt: new Date().toISOString(),
      capabilities: { apps: false, teams: false, challenges: false },
    };
    const leaderboardOut = await withHintPenalties(await withModuleContributions(data));
    const leaderboardPoints = leaderboardOut.entries[0].points;

    // 40 (raw) + 15 (quiz) - 10 (hint spend, floored at 0) = 45. Non-ai
    // points alone (40) already exceed the spend (10), so this fixture can't
    // distinguish the correct order from the pre-fix one (see the ai
    // boundary test below) — it's still flipped to match the real pipeline.
    expect(leaderboardPoints).toBe(45);
    expect(html).toContain(`>${leaderboardPoints}<`);
  });

  // The ai counterpart, at the CLAMPING BOUNDARY — this is the fixture that
  // actually distinguishes "net the total once" from the #210 bug shape
  // applied to a 4th module (net the non-ai sum first, then ADD ai on top).
  // Raw points (5) sit BELOW the hint spend (10), so the two formulas
  // diverge: correct is max(0, 5 + 15 − 10) = 10; the mutated form is
  // max(0, 5 − 10) + 15 = 0 + 15 = 15. A fixture where non-ai points alone
  // exceed the spend (e.g. the old 40/10/15 numbers) can't tell these apart —
  // both formulas land on 45 whenever B > C, since max(0, B−C)+A ==
  // max(0, A+B−C) in that regime. Driven through the REAL leaderboard overlay
  // pipeline (withHintPenalties, withModuleContributions), not a hand-rolled
  // formula, so a bug in either implementation shows up here.
  it("floors the TOTAL after folding in ai points, not before (the #210 boundary, ai enabled)", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "ai" || id === "secure-development");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({ ...baseProfile, points: 5 });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 10, count: 1 });
    getAiTotals.mockResolvedValue(new Map([["ada", { points: 15, solved: 2, lastAt: null }]]));
    getHintPenalties.mockResolvedValue(new Map([["ada", 10]]));

    const html = renderToStaticMarkup(await ProfilePage());

    const entry: LeaderboardEntry = {
      rank: 1,
      login: "ada",
      team: null,
      points: 5,
      patched: baseProfile.patched,
      failed: 0,
      total: baseProfile.total,
      apps: {},
      updatedAt: null,
    };
    const data: LeaderboardData = {
      entries: [entry],
      teams: [],
      generatedAt: new Date().toISOString(),
      capabilities: { apps: false, teams: false, challenges: false },
    };
    const leaderboardOut = await withHintPenalties(await withModuleContributions(data));
    const leaderboardPoints = leaderboardOut.entries[0].points;

    // 5 (raw) + 15 (ai) − 10 (hint spend) = 10, never floored — the spend
    // never exceeds the SUM, only the raw scorer points alone.
    expect(leaderboardPoints).toBe(10);
    expect(html).toContain(`>${leaderboardPoints}<`);
    // Pins against the mutation directly: the wrong formula's answer (15)
    // must not appear as the headline points figure either.
    expect(html).not.toContain(">15<");
  });

  // Kept as a second, non-boundary case: same shape as the quiz test above,
  // where non-ai points alone already exceed the spend.
  it("agrees with withHintPenalties + withModuleContributions for the same login (ai enabled)", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "ai" || id === "secure-development");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue(baseProfile);
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 10, count: 1 });
    getAiTotals.mockResolvedValue(new Map([["ada", { points: 15, solved: 2, lastAt: null }]]));
    getHintPenalties.mockResolvedValue(new Map([["ada", 10]]));

    const html = renderToStaticMarkup(await ProfilePage());

    const entry: LeaderboardEntry = {
      rank: 1,
      login: "ada",
      team: null,
      points: baseProfile.points,
      patched: baseProfile.patched,
      failed: 0,
      total: baseProfile.total,
      apps: {},
      updatedAt: null,
    };
    const data: LeaderboardData = {
      entries: [entry],
      teams: [],
      generatedAt: new Date().toISOString(),
      capabilities: { apps: false, teams: false, challenges: false },
    };
    const leaderboardOut = await withHintPenalties(await withModuleContributions(data));
    const leaderboardPoints = leaderboardOut.entries[0].points;

    // 40 (raw) - 10 (hint spend, floored at 0) + 15 (ai) = 45.
    expect(leaderboardPoints).toBe(45);
    expect(html).toContain(`>${leaderboardPoints}<`);
  });

  it("shows the raw (hint-only-adjusted) total when the quiz module is disabled — never reads quiz data", async () => {
    isModuleEnabled.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue(baseProfile);
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 10, count: 1 });

    const html = renderToStaticMarkup(await ProfilePage());

    expect(getQuizTotals).not.toHaveBeenCalled();
    expect(html).toContain(">30<"); // 40 - 10, no quiz points added
  });
});

describe("profile team panel member rows", () => {
  it("matches a roster member to their board row case-insensitively", async () => {
    // The roster stores the spelling the team join recorded ("ada"); the
    // board row carries the scorer's — the PR author's — spelling ("Ada").
    // The join must not render a scoring teammate as 0 pts over casing,
    // matching every other login join in the codebase.
    isModuleEnabled.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue(baseProfile);
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getHintPenalties.mockResolvedValue(new Map());
    getViewerTeam.mockResolvedValue({ slug: "red", name: "Red Team", members: ["ada"] });
    const boardEntry: LeaderboardEntry = {
      rank: 1,
      login: "Ada",
      team: "red",
      points: 77,
      patched: 1,
      failed: 0,
      total: 6,
      apps: {},
      updatedAt: null,
    };
    // capabilities.teams: true makes withTeamStandings a no-op, so the panel
    // reads exactly this standing — the test is about the member join alone.
    getLeaderboard.mockResolvedValue({
      entries: [boardEntry],
      teams: [{ rank: 1, slug: "red", name: "Red Team", captain: "ada", points: 200, members: ["ada"] }],
      generatedAt: new Date().toISOString(),
      capabilities: { apps: false, teams: true, challenges: false },
    } satisfies LeaderboardData);

    const html = renderToStaticMarkup(await ProfilePage());

    // The member row shows Ada's 77 board points, not the 0 a case-sensitive
    // find would fall back to.
    expect(html).toContain("Team progress");
    expect(html).toContain(">77<");
  });
});

describe("profile header progress fill", () => {
  it("gives a tiny nonzero score a visible minimum fill — 2 of 3,943 pts is under 0.2%, a fraction of a device pixel unfloored", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "secure-development");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({ ...baseProfile, points: 2, maxPoints: 3943 });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getHintPenalties.mockResolvedValue(new Map());

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).toContain("2 of");
    expect(html).toContain(`min-width:${MIN_FILL_PX}px`);
  });

  it("gives an all-zero score no minimum fill", async () => {
    isModuleEnabled.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({ ...baseProfile, points: 0, patched: 0, total: 0, maxPoints: 0 });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).not.toContain(`min-width:${MIN_FILL_PX}px`);
  });
});

// Regression coverage for review round 1: the per-app points figure the
// pre-module custom grid used to show ("DVWA 30 / 60 pts") was silently
// dropped when the grid was replaced by AppBreakdown/ModuleDetail, and a
// separate regression let the per-module heading show the RAW scorer total
// instead of the hint-netted one the headline and the leaderboard row use.
describe("profile per-module block content", () => {
  it("shows the per-app points figure via the reused AppBreakdown (showPoints)", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "secure-development");
    getResolvedModules.mockResolvedValue([
      {
        id: "secure-development",
        nav: { href: "/challenges", label: "Challenges" },
        targets: ["dvwa"],
        title: "Secure Development",
        blurb: "",
      },
    ]);
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({
      ...baseProfile,
      apps: [{ app: "dvwa", points: 30, maxPoints: 60, patched: 3, total: 4 }],
    });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });

    const html = renderToStaticMarkup(await ProfilePage());

    expect(html).toContain(">30<");
    expect(html).toContain("/ 60 pts");
  });

  it("shows the module block GROSS and nets hint spend once, in the headline", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "secure-development" || id === "quiz");
    // Two resolved modules so `multiModule` is true and the per-module
    // heading (which carries the points figure under test) renders at all.
    getResolvedModules.mockResolvedValue([
      {
        id: "secure-development",
        nav: { href: "/challenges", label: "Challenges" },
        targets: ["dvwa"],
        title: "Secure Development",
        blurb: "",
      },
      { id: "quiz", nav: { href: "/quiz", label: "Quiz" }, targets: [], title: "Quiz", blurb: "" },
    ]);
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({
      ...baseProfile,
      apps: [{ app: "dvwa", points: 40, maxPoints: 100, patched: 4, total: 6 }],
    });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 10, count: 1 });
    getQuizTotals.mockResolvedValue(new Map());

    const html = renderToStaticMarkup(await ProfilePage());

    // Module blocks are GROSS (40 raw), and the penalty nets the TOTAL
    // exactly once — headline 30 (40 − 10) beside the −10 hints tile —
    // matching the board's fold, which runs as the pipeline's LAST stage.
    // Netting the block too double-counted the deduction visually, and the
    // old scorer-only netting made hints free for module-only contestants.
    expect(html).toContain('>40</span><span class="text-muted"> / 100 pts</span>');
    expect(html).toContain(">30<"); // the headline points tile
    expect(html).toContain("−10");
  });

  // Regression coverage for the moduleSummary fallthrough this task closed:
  // an unconditional secure-development return with no `never` guard let an
  // ai block render silently with "patched" and the wrong denominator, and
  // tsc stayed silent about it. This pins the CONTENT (the exhaustiveness
  // check alone would only catch a MISSING arm, not a wrong one).
  it("renders the ai block with its own noun and Show-N item list, never secure-development's", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "ai");
    getResolvedModules.mockResolvedValue([
      { id: "ai", nav: { href: "/ai", label: "AI" }, targets: [], title: "AI", blurb: "" },
    ]);
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue({ ...baseProfile, apps: [] });
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getAiTotals.mockResolvedValue(new Map([["ada", { points: 20, solved: 2, lastAt: null }]]));
    listAiChallenges.mockResolvedValue([
      { id: "a1", title: "Prompt Leak", points: 10 },
      { id: "a2", title: "Guardrail Bypass", points: 10 },
      { id: "a3", title: "Jailbreak", points: 10 },
    ]);

    const html = renderToStaticMarkup(await ProfilePage());

    // "cleared" since the shared vocabulary landed — ai's own word, where it
    // used to borrow classic's "challenges".
    expect(html).toContain("cleared");
    expect(html).not.toContain("patched");
    expect(html).toMatch(/>2<\/span><span[^>]*> \/ 3 cleared<\/span>/);
    // The module row IS the disclosure now, so its items sit in the markup
    // rather than behind a second "Show N" toggle of their own.
    expect(html).toContain("Prompt Leak");
    expect(html).toContain("Jailbreak");
  });
});

// The header used to be three secure-development figures (patched /
// non-patched / total) and nothing else — a contestant whose points were
// mostly quiz got a header describing a game they weren't playing, led by a
// wall of not-done ("315 non-patched"). Issue #200, 2.4.
describe("profile header stats", () => {
  it("shows one done/available stat per enabled module and drops the non-patched wall", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "quiz" || id === "secure-development");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue(baseProfile);
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 2, lastAt: null }]]));
    listQuestions.mockResolvedValue([{ points: 10 }, { points: 20 }, { points: 30 }] as never[]);

    const html = renderToStaticMarkup(await ProfilePage());

    // Quiz gets its own header stat, in its own vocabulary: 2 of 3 answered.
    expect(html).toContain("answered");
    expect(html).toMatch(/2<span[^>]*> \/ 3<\/span>/);
    // Secure-development keeps its patched figure, now as done/available…
    expect(html).toContain("patched");
    // …and the standalone not-done headline is gone.
    expect(html).not.toContain("non-patched");
  });

  // F2 fix-round-1: the ai module had every other module's header chip but
  // its own — "One done/available stat per enabled module" was false for a
  // fourth module until this landed.
  it("shows the ai module's own header chip, in its own vocabulary", async () => {
    isModuleEnabled.mockImplementation((id: string) => id === "ai");
    getSession.mockResolvedValue({ user: { login: "ada", image: null } });
    getUser.mockResolvedValue(baseProfile);
    getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
    getAiTotals.mockResolvedValue(new Map([["ada", { points: 20, solved: 2, lastAt: null }]]));
    listAiChallenges.mockResolvedValue([{ id: "a1", points: 10 }, { id: "a2", points: 10 }, { id: "a3", points: 10 }] as never[]);

    const html = renderToStaticMarkup(await ProfilePage());

    // Its own vocabulary is "cleared" now that every surface reads the same
    // map; "challenges" was classic's word borrowed.
    expect(html).toContain("cleared");
    expect(html).toMatch(/2<span[^>]*> \/ 3<\/span>/);
  });
});
