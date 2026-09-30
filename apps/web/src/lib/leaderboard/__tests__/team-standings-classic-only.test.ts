// withTeamStandings + withModuleContributions on a CLASSIC-ONLY event: the
// source has no team concept (and no rows at all), so every row on the board
// — individual and team alike — is one these overlays create. The teams view
// is the DEFAULT board whenever teams exist, so leaving the synthesised team
// rows at `points: 0` would open a classic-only event on a scoreboard where
// every team is tied at nothing while the individual view shows real points.
//
// Own file because this fixture needs its own module set (classic only) and
// `vi.mock` is hoisted per file — the same split the sibling quiz-only files
// use.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["classic"]),
);

const mocks = vi.hoisted(() => ({
  listTeams: vi.fn<() => Promise<{ slug: string; name: string; members: string[] }[]>>(),
  getClassicTotals: vi.fn(),
  getTeamClassicTotalsBatch: vi.fn(),
  listChallenges: vi.fn(),
}));

vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/classic-store", () => ({
  getClassicTotals: mocks.getClassicTotals,
  getTeamClassicTotalsBatch: mocks.getTeamClassicTotalsBatch,
  listChallenges: mocks.listChallenges,
}));

import { withModuleContributions } from "../module-contributions";
import { withTeamStandings } from "../team-standings";

const totals = (points: number, solved: number, lastAt: string | null = null) => ({ points, solved, lastAt });

/** Stubs the batch keyed on each team's FIRST MEMBER rather than on position:
 *  `withTeamStandings` hands the batch its own (alphabetically ordered) team
 *  list, so a positional stub would silently test the order the fixture
 *  happens to produce instead of that each team got its own total. */
function totalsByMember(byMember: Record<string, ReturnType<typeof totals>>) {
  mocks.getTeamClassicTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map((members) => byMember[members[0]] ?? totals(0, 0))),
  );
}

/** Exactly what `emptySource` hands the pipeline on a classic-only event. */
const empty = (): LeaderboardData => ({
  entries: [],
  teams: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: { apps: false, teams: false, challenges: false },
});

/** The real pipeline's last two stages, in the real order. */
const pipeline = (data: LeaderboardData) => withModuleContributions(data).then(withTeamStandings);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClassicTotals.mockResolvedValue(new Map());
  mocks.listChallenges.mockResolvedValue([{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
  mocks.getTeamClassicTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => totals(0, 0))),
  );
});

describe("a classic-only event", () => {
  // Without row creation every contestant on this event is invisible: there
  // is no scored source row to overlay classic points onto.
  it("puts contestants on the board from classic points alone", async () => {
    mocks.getClassicTotals.mockResolvedValue(
      new Map([
        ["ada", totals(40, 4)],
        ["bob", totals(10, 1)],
      ]),
    );

    const out = await withModuleContributions(empty());

    expect(out.entries.map((e) => [e.login, e.points, e.rank])).toEqual([
      ["ada", 40, 1],
      ["bob", 10, 2],
    ]);
    expect(out.entries[0].modules!["classic"]!.detail).toEqual({
      kind: "classic",
      solved: 4,
      total: 4, // clamped: 4 solves against a 3-challenge list
      points: 40,
    });
  });

  it("ranks synthesised teams by their real classic points, not alphabetically", async () => {
    mocks.listTeams.mockResolvedValue([
      { slug: "z", name: "Zulu", members: ["ada"] },
      { slug: "a", name: "Alfa", members: ["bob"] },
    ]);
    // Alfa is first alphabetically but has fewer points.
    totalsByMember({ ada: totals(40, 4), bob: totals(10, 1) });

    const out = await withTeamStandings(empty());

    expect(out.teams.map((t) => [t.name, t.points, t.rank])).toEqual([
      ["Zulu", 40, 1],
      ["Alfa", 10, 2],
    ]);
    expect(out.teams[0].modules!["classic"]).toMatchObject({ points: 40, completed: 4 });
  });

  // The established team rule: a team's classic total is the UNION of the
  // challenges its members solved, so a challenge two teammates both solved
  // counts ONCE. That fold lives in getTeamClassicTotalsBatch (over the shared
  // team-fold) — this overlay must USE it and must never re-derive a team
  // score by summing member aggregates.
  it("takes the deduped team total rather than summing member points", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada", "cyd"] }]);
    // Both members hold the SAME 30-point flag: 30 as a team, 60 summed.
    mocks.getClassicTotals.mockResolvedValue(
      new Map([
        ["ada", totals(30, 1)],
        ["cyd", totals(30, 1)],
      ]),
    );
    mocks.getTeamClassicTotalsBatch.mockResolvedValue([totals(30, 1)]);

    const out = await pipeline(empty());

    expect(mocks.getTeamClassicTotalsBatch).toHaveBeenCalledTimes(1);
    expect(mocks.getTeamClassicTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"]]);
    expect(out.teams[0].points).toBe(30);
    // The individual rows still carry their own full totals — only the team
    // figure is deduped.
    expect(out.entries.map((e) => e.points)).toEqual([30, 30]);
  });

  // Rows created from classic points carry the CLASSIC store's spelling of the
  // login, while membership carries the team store's. Matching them exactly
  // would silently drop the team chip the moment the two disagreed on case.
  it("attributes a member whose casing differs from the membership record", async () => {
    mocks.getClassicTotals.mockResolvedValue(new Map([["Ada", totals(30, 3)]]));
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
    mocks.getTeamClassicTotalsBatch.mockResolvedValue([totals(30, 3)]);

    const out = await pipeline(empty());

    expect(out.entries.map((e) => [e.login, e.team])).toEqual([["Ada", "red"]]);
  });

  it("leaves the teams at zero when the team totals read fails", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
    mocks.getTeamClassicTotalsBatch.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withTeamStandings(empty());
      // Missing, never wrong: the row still renders, with no invented figure.
      expect(out.teams.map((t) => [t.slug, t.points])).toEqual([["red", 0]]);
      expect(out.teams[0].modules?.["classic"]).toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });

  // The same split the individual path keeps: the challenge list is only the
  // "solved / total" denominator, so losing it must never cost a team its
  // points or re-order the board.
  it("keeps team points and order when only the challenge list fails", async () => {
    mocks.listTeams.mockResolvedValue([
      { slug: "z", name: "Zulu", members: ["ada"] },
      { slug: "a", name: "Alfa", members: ["bob"] },
    ]);
    totalsByMember({ ada: totals(40, 4), bob: totals(10, 1) });
    mocks.listChallenges.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withTeamStandings(empty());
      expect(out.teams.map((t) => [t.name, t.points])).toEqual([
        ["Zulu", 40],
        ["Alfa", 10],
      ]);
      // Only the denominator degrades, and never below its own numerator.
      expect(out.teams[0].modules!["classic"]!.detail).toEqual({
        kind: "classic",
        solved: 4,
        total: 4,
        points: 40,
      });
    } finally {
      err.mockRestore();
    }
  });

  it("reads no team totals when there are no teams", async () => {
    mocks.listTeams.mockResolvedValue([]);
    const base = empty();
    expect(await withTeamStandings(base)).toBe(base);
    expect(mocks.getTeamClassicTotalsBatch).not.toHaveBeenCalled();
  });

  // A source that already provides deduped team rows (mock/lambda) had its
  // classic points added by withModuleContributions one step earlier; this
  // overlay must not touch them a second time.
  it("no-ops on a source that already carries teams, so points are never added twice", async () => {
    const base: LeaderboardData = {
      ...empty(),
      teams: [{ rank: 1, slug: "red", name: "Red", captain: "ada", points: 50, members: ["ada"] }],
      capabilities: { apps: true, teams: true, challenges: false },
    };

    const out = await withTeamStandings(base);

    expect(out).toBe(base);
    expect(mocks.getTeamClassicTotalsBatch).not.toHaveBeenCalled();
  });
});
