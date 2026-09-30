// withModuleContributions on a QUIZ-ONLY event: no scorer, no scored entries,
// so every row on the board is one this overlay created from quiz points.
//
// `vi.mock` is hoisted per file, so this fixture's own module set cannot
// share a file with the sibling module-contributions.test.ts's
// (secure-development-enabled) fixture; see modules-resolve.test.ts for the
// same split.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData, LeaderboardEntry, TeamStanding } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);

const mocks = vi.hoisted(() => ({
  getQuizTotals: vi.fn(),
  getTeamQuizTotalsBatch: vi.fn(),
  listQuestions: vi.fn(),
}));

vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals: mocks.getQuizTotals,
  getTeamQuizTotalsBatch: mocks.getTeamQuizTotalsBatch,
  listQuestions: mocks.listQuestions,
}));

import { withModuleContributions } from "../module-contributions";

/** Exactly what `emptySource` hands the pipeline on a quiz-only event. */
const empty = (): LeaderboardData => ({
  entries: [],
  teams: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: { apps: false, teams: false, challenges: false },
});

const totals = (points: number, answered: number, lastAt: string | null = null) => ({
  points,
  answered,
  lastAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getQuizTotals.mockResolvedValue(new Map());
  mocks.listQuestions.mockResolvedValue([{ id: "q1" }, { id: "q2" }, { id: "q3" }]);
  mocks.getTeamQuizTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => totals(0, 0))),
  );
});

describe("withModuleContributions on a quiz-only event", () => {
  it("creates a row for a login with module points and no scoring entry", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => e.login)).toEqual(["ada"]);
    expect(out.entries[0].points).toBe(30);
    expect(out.entries[0].rank).toBe(1);
    // Nothing was scored by a backend that isn't running: the
    // secure-development columns stay at zero rather than inheriting the
    // quiz's numbers.
    expect(out.entries[0]).toMatchObject({ patched: 0, failed: 0, total: 0, apps: {}, team: null });
    expect(out.entries[0].modules).toEqual({
      quiz: {
        points: 30,
        completed: 3,
        lastActivityAt: null,
        detail: { kind: "quiz", answered: 3, total: 3, points: 30 },
      },
    });
  });

  // `getQuizTotals` has no timestamp to give today (both aggregates are running
  // totals), so `lastAt` is null in practice — but a created row has no
  // scorer-supplied `updatedAt`/`lastSolveAt` of its own, and the module's own
  // activity time is the only honest source for both if it ever gains one.
  it("carries the module's activity time onto the created row", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3, "2026-08-01T11:00:00.000Z")]]));

    const out = await withModuleContributions(empty());

    expect(out.entries[0].updatedAt).toBe("2026-08-01T11:00:00.000Z");
    expect(out.entries[0].lastSolveAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("leaves the created row's times null when the module has none", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));

    const out = await withModuleContributions(empty());

    expect(out.entries[0].updatedAt).toBeNull();
    expect(out.entries[0].lastSolveAt).toBeNull();
  });

  it("never stamps a secure-development block, because the module is disabled", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    const out = await withModuleContributions(empty());
    expect(out.entries[0].modules!["secure-development"]).toBeUndefined();
  });

  // C4/C6 mirror image: with secure-development disabled no row ever carries a
  // secure-development block, so rank.ts's `completedCount` falls back to
  // `patched` — which is 0 on every created row. The items tiebreak must
  // therefore count quiz answers, not collapse to every row's 0. The Phase 2
  // ranking bug was only ever caught with the quiz off; this is the same
  // comparator exercised with secure-development off.
  it("ranks created rows on points first, then answers (#522)", async () => {
    mocks.getQuizTotals.mockResolvedValue(
      new Map([
        ["grinder", totals(20, 4)], // four cheap questions
        ["scorer", totals(90, 1)], // one expensive one
      ]),
    );

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([
      ["scorer", 1],
      ["grinder", 2],
    ]);
  });

  it("breaks a points tie on answer count", async () => {
    mocks.getQuizTotals.mockResolvedValue(
      new Map([
        ["fewer", totals(40, 1)],
        ["more", totals(40, 4)],
      ]),
    );

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => e.login)).toEqual(["more", "fewer"]);
  });

  it("stamps sequential ranks across the created field", async () => {
    mocks.getQuizTotals.mockResolvedValue(
      new Map([
        ["c", totals(10, 1)],
        ["a", totals(70, 7)],
        ["b", totals(30, 3)],
      ]),
    );

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  // C4: fail toward showing LESS, never toward showing something false. A
  // board of invented zero-point rows would look like a working leaderboard
  // that everyone is losing on.
  it("creates no rows when the totals read fails", async () => {
    mocks.getQuizTotals.mockRejectedValue(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withModuleContributions(empty());
      expect(out.entries).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });

  it("keeps every created row's points when only the question list fails", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    mocks.listQuestions.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withModuleContributions(empty());
      expect(out.entries[0].points).toBe(30);
      // Only the denominator degrades, and never below its own numerator.
      expect(out.entries[0].modules!["quiz"]!.detail).toEqual({
        kind: "quiz",
        answered: 3,
        total: 3,
        points: 30,
      });
    } finally {
      err.mockRestore();
    }
  });

  it("creates no rows for a login that has answered nothing", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(0, 0)]]));
    const out = await withModuleContributions(empty());
    expect(out.entries).toEqual([]);
  });

  it("leaves an empty board empty", async () => {
    const out = await withModuleContributions(empty());
    expect(out.entries).toEqual([]);
    expect(out.teams).toEqual([]);
  });

  // The empty source reports `capabilities.teams: false`, so team quiz points
  // stay withTeamStandings' problem — this overlay has no deduped team rows to
  // attach anything to and must not invent them either.
  it("does not read team quiz totals when the source has no team rows", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    const teams: TeamStanding[] = [
      { rank: 1, slug: "red", name: "Red", captain: "ada", points: 0, members: ["ada"] },
    ];

    const out = await withModuleContributions({ ...empty(), teams });

    expect(mocks.getTeamQuizTotalsBatch).not.toHaveBeenCalled();
    expect(out.teams).toEqual(teams);
  });

  // Belt and braces for the union: even on a board with no scoring backend, a
  // row that somehow arrives with this login must not be joined by a created
  // twin.
  it("overlays onto an existing row rather than creating a second one", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    const existing: LeaderboardEntry = {
      rank: 1, login: "ada", team: null, points: 0, patched: 0, failed: 0, total: 0,
      apps: {}, updatedAt: null, lastSolveAt: null,
    };

    const out = await withModuleContributions({ ...empty(), entries: [existing] });

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].points).toBe(30);
  });
});
