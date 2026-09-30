// The leaderboard page's fixed composition order:
//   withModuleContributions → withTeamStandings → withHintPenalties
// These tests pin the properties that order exists to guarantee — above all
// that the hint penalty nets the FINAL all-module total, exactly once. It
// used to run FIRST, netting scorer points alone, which made hints free for
// any row whose points arrive later: a quiz/classic-only contestant (row
// created by module contributions) had nothing to deduct from.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => mocks.moduleLive(id)),
);

const mocks = vi.hoisted(() => ({
  moduleLive: vi.fn((id: string) => id === "secure-development"),
  getQuizTotals: vi.fn(),
  getTeamQuizTotalsBatch: vi.fn(),
  listQuestions: vi.fn(),
  getClassicTotals: vi.fn(),
  getTeamClassicTotalsBatch: vi.fn(),
  listChallenges: vi.fn(),
  getAiTotals: vi.fn(),
  getTeamAiTotalsBatch: vi.fn(),
  listAiChallenges: vi.fn(),
}));
vi.mock("@/lib/modules", () => ({
  enabledModules: [{ id: "secure-development", displayName: "Secure Development", description: "", targets: ["dvwa"] }],
}));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals: mocks.getQuizTotals,
  getTeamQuizTotalsBatch: mocks.getTeamQuizTotalsBatch,
  listQuestions: mocks.listQuestions,
}));
vi.mock("@/lib/classic-store", () => ({
  getClassicTotals: mocks.getClassicTotals,
  getTeamClassicTotalsBatch: mocks.getTeamClassicTotalsBatch,
  listChallenges: mocks.listChallenges,
}));
vi.mock("@/lib/ai-store", () => ({
  getAiTotals: mocks.getAiTotals,
  getTeamAiTotalsBatch: mocks.getTeamAiTotalsBatch,
  listAiChallenges: mocks.listAiChallenges,
}));
const teamStore = vi.hoisted(() => ({ listTeams: vi.fn() }));
vi.mock("@/lib/team-store", () => ({ listTeams: teamStore.listTeams }));

// Mutable so a single module graph can cover both the hints-off and hints-on
// pipelines (vi.mock is hoisted and applies for the whole file).
const hints = { enabled: false, penalties: new Map<string, number>() };
vi.mock("@/lib/hint-store", () => ({
  // Policy now lives inside getHintPenalties (it consults resolveHintConfig),
  // so an "off" event yields an empty map rather than a false capability flag.
  getHintPenalties: async () => (hints.enabled ? hints.penalties : new Map<string, number>()),
  HINTS_AVAILABLE: true,
}));

import { withModuleContributions } from "../module-contributions";
import { withTeamStandings } from "../team-standings";
import { withHintPenalties } from "../hint-penalties";

const base: LeaderboardData = {
  entries: [
    { rank: 1, login: "bob", team: null, points: 10, patched: 1, failed: 0, total: 3, apps: { dvwa: { app: "dvwa", points: 10, maxPoints: 30, patched: 1, total: 3 } }, updatedAt: null, lastSolveAt: "2026-08-01T09:00:00.000Z" },
    { rank: 2, login: "ada", team: null, points: 30, patched: 3, failed: 0, total: 3, apps: { dvwa: { app: "dvwa", points: 30, maxPoints: 30, patched: 3, total: 3 } }, updatedAt: null, lastSolveAt: "2026-08-01T10:00:00.000Z" },
  ],
  teams: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: { apps: true, teams: false, challenges: false },
};

// The page's real order — ALL THREE stages, so a synthesised team row's
// penalty behaviour is exercised too, not just entries'.
const pipeline = (data: LeaderboardData) =>
  withModuleContributions(data).then(withTeamStandings).then(withHintPenalties);

beforeEach(() => {
  vi.clearAllMocks();
  hints.enabled = false;
  hints.penalties = new Map();
  mocks.moduleLive.mockImplementation((id: string) => id === "secure-development");
  mocks.getQuizTotals.mockResolvedValue(new Map());
  mocks.listQuestions.mockResolvedValue([]);
  mocks.getClassicTotals.mockResolvedValue(new Map());
  mocks.listChallenges.mockResolvedValue([]);
  mocks.getAiTotals.mockResolvedValue(new Map());
  mocks.listAiChallenges.mockResolvedValue([]);
  teamStore.listTeams.mockResolvedValue([]);
});

describe("leaderboard pipeline", () => {
  it("orders by combined standing even with hints disabled", async () => {
    const out = await pipeline(base);
    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([["ada", 1], ["bob", 2]]);
  });

  it("shows module blocks GROSS and nets the penalty once, at the row level", async () => {
    hints.enabled = true;
    hints.penalties = new Map([["ada", 10]]);
    const out = await pipeline(base);
    const ada = out.entries.find((e) => e.login === "ada")!;
    // Header: net, with the marker that reconciles it against the block.
    expect(ada.points).toBe(20);
    expect(ada.hintPenalty).toBe(10);
    // Block: gross — the −10 appears exactly once, on the row.
    expect(ada.modules!["secure-development"]!.points).toBe(30);
  });

  it("re-ranks on the penalised totals", async () => {
    hints.enabled = true;
    // ada (30) buys 25 points of hints; bob (10) stays clean. compareStanding
    // ranks points first (#522), so ada's net 5 drops her below bob — the
    // order has to come from the NETTED totals, not the gross ones.
    hints.penalties = new Map([["ada", 25]]);
    const out = await pipeline(base);
    const ada = out.entries.find((e) => e.login === "ada")!;
    expect(ada.points).toBe(5);
    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([["bob", 1], ["ada", 2]]);
  });

  // A team row SYNTHESISED by withTeamStandings (the upstash path: no source
  // teams) is penalised on its members' spend like any other — the second
  // row shape the old first-stage fold never saw.
  it("charges a synthesised team row its members' hint spend", async () => {
    mocks.moduleLive.mockImplementation((id: string) => id === "quiz");
    mocks.getQuizTotals.mockResolvedValue(new Map([["carol", { points: 100, answered: 4, lastAt: "2026-08-01T11:00:00.000Z" }]]));
    mocks.getTeamQuizTotalsBatch.mockResolvedValue([{ points: 100, answered: 4, lastAt: "2026-08-01T11:00:00.000Z" }]);
    mocks.listQuestions.mockResolvedValue([{}, {}, {}, {}]);
    teamStore.listTeams.mockResolvedValue([{ slug: "solo-carol", name: "Solo Carol", members: ["carol"] }]);
    hints.enabled = true;
    hints.penalties = new Map([["carol", 30]]);

    const out = await pipeline({ ...base, entries: [], capabilities: { apps: false, teams: false, challenges: false } });
    const team = out.teams.find((t) => t.slug === "solo-carol")!;
    expect(team.points).toBe(70); // 100 quiz − 30 hints
    expect(team.hintPenalty).toBe(30);
  });

  // THE fix this order exists for: a contestant with no scorer row — their
  // points exist only through module contributions — must still pay for
  // hints. With the overlay first, their deduction was max(0, 0 − spend) on a
  // row that didn't exist yet, i.e. nothing.
  it("charges hint spend to a module-only contestant's created row", async () => {
    mocks.moduleLive.mockImplementation((id: string) => id === "quiz");
    mocks.getQuizTotals.mockResolvedValue(new Map([["carol", { points: 100, answered: 4, lastAt: "2026-08-01T11:00:00.000Z" }]]));
    mocks.listQuestions.mockResolvedValue([{}, {}, {}, {}]);
    hints.enabled = true;
    hints.penalties = new Map([["carol", 30]]);

    const out = await pipeline({ ...base, entries: [], capabilities: { apps: false, teams: false, challenges: false } });
    const carol = out.entries.find((e) => e.login === "carol")!;
    expect(carol.points).toBe(70); // 100 quiz − 30 hints, NOT 100
    expect(carol.hintPenalty).toBe(30);
    expect(carol.modules!.quiz!.points).toBe(100); // the block stays gross
  });

  // ai's counterpart to the two tests above: an ai block plus a hint spend
  // must show the block un-netted and the row's hintPenalty carrying the
  // spend — GROSS everywhere, penalties fold last regardless of which
  // app-side module supplied the points.
  it("shows an ai block GROSS and nets the penalty once, at the row level", async () => {
    mocks.moduleLive.mockImplementation((id: string) => id === "secure-development" || id === "ai");
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", { points: 20, solved: 2, lastAt: null }]]));
    mocks.listAiChallenges.mockResolvedValue([{}, {}]);
    hints.enabled = true;
    hints.penalties = new Map([["ada", 10]]);

    const out = await pipeline(base);
    const ada = out.entries.find((e) => e.login === "ada")!;
    // Header: net. Block: gross — the −10 appears exactly once, on the row.
    expect(ada.points).toBe(40); // 30 secure-dev + 20 ai − 10 hints
    expect(ada.hintPenalty).toBe(10);
    expect(ada.modules!["ai"]!.points).toBe(20);
    expect(ada.modules!["secure-development"]!.points).toBe(30);
  });

  it("charges hint spend to an ai-only contestant's created row", async () => {
    mocks.moduleLive.mockImplementation((id: string) => id === "ai");
    mocks.getAiTotals.mockResolvedValue(new Map([["carol", { points: 100, solved: 4, lastAt: "2026-08-01T11:00:00.000Z" }]]));
    mocks.listAiChallenges.mockResolvedValue([{}, {}, {}, {}]);
    hints.enabled = true;
    hints.penalties = new Map([["carol", 30]]);

    const out = await pipeline({ ...base, entries: [], capabilities: { apps: false, teams: false, challenges: false } });
    const carol = out.entries.find((e) => e.login === "carol")!;
    expect(carol.points).toBe(70); // 100 ai − 30 hints, NOT 100
    expect(carol.hintPenalty).toBe(30);
    expect(carol.modules!.ai!.points).toBe(100); // the block stays gross
  });
});
