// withModuleContributions on an AI-ONLY event: no scorer, no scored entries,
// so every row on the board is one this overlay created from ai points.
// Mirrors module-contributions-quiz-only.test.ts's structure.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData, LeaderboardEntry, TeamStanding } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["ai"]),
);

const mocks = vi.hoisted(() => ({
  getAiTotals: vi.fn(),
  getTeamAiTotalsBatch: vi.fn(),
  listAiChallenges: vi.fn(),
}));

vi.mock("@/lib/ai-store", () => ({
  getAiTotals: mocks.getAiTotals,
  getTeamAiTotalsBatch: mocks.getTeamAiTotalsBatch,
  listAiChallenges: mocks.listAiChallenges,
}));

import { withModuleContributions } from "../module-contributions";

/** Exactly what `emptySource` hands the pipeline on an ai-only event. */
const empty = (): LeaderboardData => ({
  entries: [],
  teams: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: { apps: false, teams: false, challenges: false },
});

const totals = (points: number, solved: number, lastAt: string | null = null) => ({
  points,
  solved,
  lastAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAiTotals.mockResolvedValue(new Map());
  mocks.listAiChallenges.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
  mocks.getTeamAiTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => totals(0, 0))),
  );
});

describe("withModuleContributions on an ai-only event", () => {
  it("creates a row for a login with module points and no scoring entry", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => e.login)).toEqual(["ada"]);
    expect(out.entries[0].points).toBe(30);
    expect(out.entries[0].rank).toBe(1);
    expect(out.entries[0]).toMatchObject({ patched: 0, failed: 0, total: 0, apps: {}, team: null });
    expect(out.entries[0].modules).toEqual({
      ai: {
        points: 30,
        completed: 3,
        lastActivityAt: null,
        detail: { kind: "ai", solved: 3, total: 3, points: 30 },
      },
    });
  });

  it("carries the module's activity time onto the created row", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3, "2026-08-01T11:00:00.000Z")]]));

    const out = await withModuleContributions(empty());

    expect(out.entries[0].updatedAt).toBe("2026-08-01T11:00:00.000Z");
    expect(out.entries[0].lastSolveAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("leaves the created row's times null when the module has none", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));

    const out = await withModuleContributions(empty());

    expect(out.entries[0].updatedAt).toBeNull();
    expect(out.entries[0].lastSolveAt).toBeNull();
  });

  it("never stamps a secure-development block, because the module is disabled", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    const out = await withModuleContributions(empty());
    expect(out.entries[0].modules!["secure-development"]).toBeUndefined();
  });

  it("ranks created rows on solves first, then points", async () => {
    mocks.getAiTotals.mockResolvedValue(
      new Map([
        ["hoarder", totals(90, 1)], // one expensive challenge
        ["grinder", totals(20, 4)], // four cheap ones
      ]),
    );

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([
      ["grinder", 1],
      ["hoarder", 2],
    ]);
  });

  it("breaks a solve-count tie on points", async () => {
    mocks.getAiTotals.mockResolvedValue(
      new Map([
        ["cheap", totals(20, 2)],
        ["dear", totals(50, 2)],
      ]),
    );

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => e.login)).toEqual(["dear", "cheap"]);
  });

  it("stamps sequential ranks across the created field", async () => {
    mocks.getAiTotals.mockResolvedValue(
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

  it("creates no rows when the totals read fails", async () => {
    mocks.getAiTotals.mockRejectedValue(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withModuleContributions(empty());
      expect(out.entries).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });

  it("keeps every created row's points when only the challenge list fails", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    mocks.listAiChallenges.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withModuleContributions(empty());
      expect(out.entries[0].points).toBe(30);
      expect(out.entries[0].modules!["ai"]!.detail).toEqual({
        kind: "ai",
        solved: 3,
        total: 3,
        points: 30,
      });
    } finally {
      err.mockRestore();
    }
  });

  it("creates no rows for a login that has solved nothing", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(0, 0)]]));
    const out = await withModuleContributions(empty());
    expect(out.entries).toEqual([]);
  });

  it("leaves an empty board empty", async () => {
    const out = await withModuleContributions(empty());
    expect(out.entries).toEqual([]);
    expect(out.teams).toEqual([]);
  });

  it("does not read team ai totals when the source has no team rows", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    const teams: TeamStanding[] = [
      { rank: 1, slug: "red", name: "Red", captain: "ada", points: 0, members: ["ada"] },
    ];

    const out = await withModuleContributions({ ...empty(), teams });

    expect(mocks.getTeamAiTotalsBatch).not.toHaveBeenCalled();
    expect(out.teams).toEqual(teams);
  });

  it("overlays onto an existing row rather than creating a second one", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["ada", totals(30, 3)]]));
    const existing: LeaderboardEntry = {
      rank: 1, login: "ada", team: null, points: 0, patched: 0, failed: 0, total: 0,
      apps: {}, updatedAt: null, lastSolveAt: null,
    };

    const out = await withModuleContributions({ ...empty(), entries: [existing] });

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].points).toBe(30);
  });
});
