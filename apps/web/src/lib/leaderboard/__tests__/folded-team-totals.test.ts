// Issue #520: every TEAM's total on a scorer-sourced board counted its quiz,
// Jeopardy (classic) and AI points twice. Each stage's own suite passed —
// withModuleContributions attributed the app-side modules onto the source's
// teams, withTeamStandings attributed them again over the union of source and
// membership-only teams, and each was right in isolation. Only the COMPOSED
// fold was wrong, so this suite runs the production fold itself:
// `getFoldedLeaderboard()` with no `fold` override, i.e. the real
// source → contributions → standings → series → penalties chain, with only the
// stores beneath it stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData } from "../types";
import type { QuizTotal } from "@/lib/quiz-store";
import type { ClassicTotal } from "@/lib/classic-store";
import type { AiTotal } from "@/lib/ai-store";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development", "quiz", "classic", "ai"]),
);

const mocks = vi.hoisted(() => ({
  board: null as unknown as () => LeaderboardData,
  getQuizTotals: vi.fn(),
  getTeamQuizTotalsBatch: vi.fn(),
  listQuestions: vi.fn(),
  getClassicTotals: vi.fn(),
  getTeamClassicTotalsBatch: vi.fn(),
  listChallenges: vi.fn(),
  listStories: vi.fn(),
  getAiTotals: vi.fn(),
  getTeamAiTotalsBatch: vi.fn(),
  listAiChallenges: vi.fn(),
  listTeams: vi.fn(),
  penalties: new Map<string, number>(),
}));

vi.mock("../source", () => ({
  getLeaderboardSource: async () => ({ getLeaderboard: async () => mocks.board() }),
}));
vi.mock("@/lib/enabled-apps", () => ({ getEnabledTotals: async () => ({ challenges: 3 }) }));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals: mocks.getQuizTotals,
  getTeamQuizTotalsBatch: mocks.getTeamQuizTotalsBatch,
  listQuestions: mocks.listQuestions,
}));
vi.mock("@/lib/classic-store", () => ({
  getClassicTotals: mocks.getClassicTotals,
  getTeamClassicTotalsBatch: mocks.getTeamClassicTotalsBatch,
  listChallenges: mocks.listChallenges,
  listStories: mocks.listStories,
}));
vi.mock("@/lib/ai-store", () => ({
  getAiTotals: mocks.getAiTotals,
  getTeamAiTotalsBatch: mocks.getTeamAiTotalsBatch,
  listAiChallenges: mocks.listAiChallenges,
}));
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/hint-config", () => ({
  getHintPenalties: async () => mocks.penalties,
  HINTS_AVAILABLE: true,
}));
// withModuleSeries reads each member's per-item hashes to chart them; an empty
// result per command is "nothing to chart" and leaves `points` untouched.
vi.mock("@/lib/upstash", () => ({
  upstashPipeline: async (commands: unknown[]) => commands.map(() => ({ result: [] })),
}));

import { getFoldedLeaderboard, resetFoldedLeaderboardCache } from "../folded";

const dvwa = (points: number, patched: number) => ({
  dvwa: { app: "dvwa" as const, points, maxPoints: 3000, patched, total: 3 },
});

// Two scorer teams whose order the bug FLIPS: sd-heavy scores in secure
// development alone (2500), byte-me mostly app-side (58 SD + 2050 modules =
// 2108). Correct: sd-heavy first. Doubled: byte-me at 4158 overtakes it.
// app-only is a team contestants created that the scorer has never heard of.
const scorerBoard = (): LeaderboardData => ({
  entries: [
    { rank: 1, login: "carol", team: "sd-heavy", points: 2500, patched: 3, failed: 0, total: 3, apps: dvwa(2500, 3), updatedAt: null },
    { rank: 2, login: "alice", team: "byte-me", points: 58, patched: 1, failed: 0, total: 3, apps: dvwa(58, 1), updatedAt: null },
  ],
  teams: [
    { rank: 1, slug: "sd-heavy", name: "SD Heavy", captain: "carol", points: 2500, members: ["carol"], apps: dvwa(2500, 3) },
    { rank: 2, slug: "byte-me", name: "Byte Me", captain: "alice", points: 58, members: ["alice", "bob"], apps: dvwa(58, 1) },
  ],
  generatedAt: "2026-09-30T00:00:00.000Z",
  capabilities: { apps: true, teams: true, challenges: false },
});

// Per-team module totals, keyed by roster so the stub answers whichever
// stage asks, in whatever order it lists the teams.
const byRoster = <T>(table: Record<string, T>, empty: T) => async (rosters: string[][]) =>
  rosters.map((members) => table[[...members].map((m) => m.toLowerCase()).sort().join(",")] ?? empty);

beforeEach(() => {
  vi.clearAllMocks();
  resetFoldedLeaderboardCache();
  mocks.board = scorerBoard;
  mocks.penalties = new Map();

  mocks.getQuizTotals.mockResolvedValue(
    new Map([
      ["alice", { points: 275, answered: 3, lastAt: null }],
      ["dave", { points: 100, answered: 1, lastAt: null }],
    ]),
  );
  mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 1125, solved: 4, lastAt: null }]]));
  mocks.getAiTotals.mockResolvedValue(new Map([["bob", { points: 650, solved: 2, lastAt: null }]]));

  const noQuiz: QuizTotal = { points: 0, answered: 0, lastAt: null };
  const noClassic: ClassicTotal = { points: 0, solved: 0, lastAt: null };
  const noAi: AiTotal = { points: 0, solved: 0, lastAt: null };
  mocks.getTeamQuizTotalsBatch.mockImplementation(
    byRoster(
      {
        "alice,bob": { points: 275, answered: 3, lastAt: null, itemIds: ["q1", "q2", "q-gone"] },
        dave: { points: 100, answered: 1, lastAt: null, itemIds: ["q1"] },
      },
      noQuiz,
    ),
  );
  mocks.getTeamClassicTotalsBatch.mockImplementation(
    byRoster({ "alice,bob": { points: 1125, solved: 4, lastAt: null, itemIds: ["c1", "c2", "c3", "c-gone"] } }, noClassic),
  );
  mocks.getTeamAiTotalsBatch.mockImplementation(
    byRoster({ "alice,bob": { points: 650, solved: 2, lastAt: null, itemIds: ["a1", "a-gone"] } }, noAi),
  );
  mocks.listQuestions.mockResolvedValue(["q1", "q2", "q3", "q4", "q5"].map((id) => ({ id })));
  mocks.listChallenges.mockResolvedValue(["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({ id })));
  mocks.listStories.mockResolvedValue([]);
  mocks.listAiChallenges.mockResolvedValue(["a1", "a2", "a3"].map((id) => ({ id })));

  mocks.listTeams.mockResolvedValue([
    { slug: "sd-heavy", name: "SD Heavy", members: ["carol"] },
    { slug: "byte-me", name: "Byte Me", members: ["alice", "bob"] },
    { slug: "app-only", name: "App Only", members: ["dave"] },
  ]);
});

describe("the production fold's team totals (issue #520)", () => {
  it("adds each app-side module to a scorer team's total exactly once", async () => {
    const out = await getFoldedLeaderboard();
    const byteMe = out.teams.find((t) => t.slug === "byte-me")!;

    // 58 SD + 275 quiz + 1125 classic + 650 ai — once. The bug served 4158.
    expect(byteMe.points).toBe(58 + 275 + 1125 + 650);

    // The chips were always right; pin that the fix keeps them so, and that
    // they add up to the header.
    expect(byteMe.modules?.["secure-development"]?.points).toBe(58);
    expect(byteMe.modules?.quiz?.points).toBe(275);
    expect(byteMe.modules?.classic?.points).toBe(1125);
    expect(byteMe.modules?.ai?.points).toBe(650);
    const chipSum = Object.values(byteMe.modules ?? {}).reduce((n, m) => n + (m?.points ?? 0), 0);
    expect(chipSum).toBe(byteMe.points);
  });

  it("ranks the teams on the single-counted totals", async () => {
    const out = await getFoldedLeaderboard();
    expect(out.teams.map((t) => [t.slug, t.points, t.rank])).toEqual([
      ["sd-heavy", 2500, 1],
      ["byte-me", 2108, 2],
      ["app-only", 100, 3],
    ]);
  });

  it("gives a membership-only team its module points once", async () => {
    const out = await getFoldedLeaderboard();
    const appOnly = out.teams.find((t) => t.slug === "app-only")!;
    expect(appOnly.points).toBe(100);
    expect(appOnly.modules?.quiz?.points).toBe(100);
  });

  it("leaves contestant rows as they were", async () => {
    const out = await getFoldedLeaderboard();
    const points = Object.fromEntries(out.entries.map((e) => [e.login, e.points]));
    expect(points).toEqual({ carol: 2500, alice: 58 + 275 + 1125, bob: 650, dave: 100 });
  });

  // A solved item whose challenge was since deleted still counts in the
  // numerator, so the denominator is the live catalogue UNIONED with it (#350)
  // — 5+1 questions, 6+1 challenges, 3+1 ai challenges — on every module.
  it("keeps each chip's denominator on the live-catalogue union", async () => {
    const out = await getFoldedLeaderboard();
    const byteMe = out.teams.find((t) => t.slug === "byte-me")!;
    expect(byteMe.modules?.quiz?.detail).toMatchObject({ total: 6 });
    expect(byteMe.modules?.classic?.detail).toMatchObject({ total: 7 });
    expect(byteMe.modules?.ai?.detail).toMatchObject({ total: 4 });
  });

  it("nets the hint penalty once, after the single-counted total", async () => {
    mocks.penalties = new Map([["bob", 8]]);
    const out = await getFoldedLeaderboard();
    const byteMe = out.teams.find((t) => t.slug === "byte-me")!;
    expect(byteMe.points).toBe(2108 - 8);
    expect(byteMe.hintPenalty).toBe(8);
    // Blocks stay gross.
    expect(byteMe.modules?.ai?.points).toBe(650);
  });

  // The team store is a second record, not a precondition: a scorer board
  // whose store read fails (or holds no teams yet) must still count every
  // module on the scorer's own teams — once.
  it.each([
    ["the team store is empty", () => mocks.listTeams.mockResolvedValue([])],
    ["the team store read fails", () => mocks.listTeams.mockRejectedValue(new Error("NOAUTH"))],
  ])("still counts a scorer team's modules once when %s", async (_label, arrange) => {
    arrange();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await getFoldedLeaderboard();
    spy.mockRestore();
    expect(out.teams.map((t) => [t.slug, t.points, t.rank])).toEqual([
      ["sd-heavy", 2500, 1],
      ["byte-me", 2108, 2],
    ]);
  });
});
