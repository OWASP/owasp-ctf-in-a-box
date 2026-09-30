// withTeamStandings on a QUIZ-ONLY event: the source has no team concept (and
// no rows at all), so every team row on the board is one this overlay
// synthesises from membership — and the teams view is the DEFAULT board
// whenever teams exist. Leaving those rows at `points: 0` opened a quiz-only
// event on a scoreboard where every team was tied at nothing while the
// individual view showed real points.
//
// Own file because this fixture needs its own module set and `vi.mock` is
// hoisted per file — see modules-resolve.test.ts. The sibling
// team-standings.test.ts covers the quiz-disabled behaviour, where this
// overlay must stay exactly as it was.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);

const mocks = vi.hoisted(() => ({
  listTeams: vi.fn<() => Promise<{ slug: string; name: string; members: string[] }[]>>(),
  getQuizTotals: vi.fn(),
  getTeamQuizTotalsBatch: vi.fn(),
  listQuestions: vi.fn(),
}));

vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals: mocks.getQuizTotals,
  getTeamQuizTotalsBatch: mocks.getTeamQuizTotalsBatch,
  listQuestions: mocks.listQuestions,
}));

import { withModuleContributions } from "../module-contributions";
import { withTeamStandings } from "../team-standings";

const totals = (points: number, answered: number, lastAt: string | null = null) => ({ points, answered, lastAt });

/** Stubs the batch keyed on each team's FIRST MEMBER rather than on position:
 *  `withTeamStandings` hands the batch its own (alphabetically ordered) team
 *  list, so a positional stub would silently test the order the fixture
 *  happens to produce instead of that each team got its own total. */
function totalsByMember(byMember: Record<string, ReturnType<typeof totals>>) {
  mocks.getTeamQuizTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map((members) => byMember[members[0]] ?? totals(0, 0))),
  );
}

/** Exactly what `emptySource` hands the pipeline on a quiz-only event. */
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
  mocks.getQuizTotals.mockResolvedValue(new Map());
  mocks.listQuestions.mockResolvedValue([{ id: "q1" }, { id: "q2" }, { id: "q3" }]);
  mocks.getTeamQuizTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => totals(0, 0))),
  );
});

describe("withTeamStandings on a quiz-only event", () => {
  it("ranks synthesised teams by their real quiz points, not alphabetically", async () => {
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
    expect(out.teams[0].modules!["quiz"]).toMatchObject({ points: 40, completed: 4 });
  });

  // The established team rule: a team's quiz total is the UNION of the
  // questions its members answered, so a question two teammates both answered
  // counts ONCE. That fold lives in getTeamQuizTotalsBatch (and is proven at
  // the store level in quiz-store.test.ts) — this overlay must USE it and must
  // never re-derive a team score by summing member aggregates.
  it("takes the deduped team total rather than summing member points", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada", "cyd"] }]);
    // Both members banked the SAME 30-point question: 30 as a team, 60 summed.
    mocks.getQuizTotals.mockResolvedValue(
      new Map([
        ["ada", totals(30, 1)],
        ["cyd", totals(30, 1)],
      ]),
    );
    mocks.getTeamQuizTotalsBatch.mockResolvedValue([totals(30, 1)]);

    const out = await pipeline(empty());

    expect(mocks.getTeamQuizTotalsBatch).toHaveBeenCalledTimes(1);
    expect(mocks.getTeamQuizTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"]]);
    expect(out.teams[0].points).toBe(30);
    // The individual rows still carry their own full totals — only the team
    // figure is deduped.
    expect(out.entries.map((e) => e.points)).toEqual([30, 30]);
  });

  it("asks for every team's total in a single batched call", async () => {
    mocks.listTeams.mockResolvedValue([
      { slug: "red", name: "Red", members: ["ada"] },
      { slug: "blue", name: "Blue", members: ["bob"] },
      { slug: "grey", name: "Grey", members: ["cyd"] },
    ]);
    totalsByMember({ ada: totals(30, 3), bob: totals(20, 2), cyd: totals(0, 0) });

    const out = await withTeamStandings(empty());

    expect(mocks.getTeamQuizTotalsBatch).toHaveBeenCalledTimes(1);
    expect(out.teams.map((t) => [t.slug, t.points])).toEqual([
      ["red", 30],
      ["blue", 20],
      ["grey", 0],
    ]);
    // A team with no answers gets no block rather than an empty one.
    expect(out.teams.find((t) => t.slug === "grey")!.modules?.["quiz"]).toBeUndefined();
  });

  // Rows created from quiz points carry the QUIZ store's spelling of the
  // login, while membership carries the team store's. Matching them exactly
  // would silently drop the team chip the moment the two disagreed on case.
  it("attributes a member whose casing differs from the membership record", async () => {
    mocks.getQuizTotals.mockResolvedValue(new Map([["Ada", totals(30, 3)]]));
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
    mocks.getTeamQuizTotalsBatch.mockResolvedValue([totals(30, 3)]);

    const out = await pipeline(empty());

    expect(out.entries.map((e) => [e.login, e.team])).toEqual([["Ada", "red"]]);
  });

  it("keeps the alphabetical order when no team has any module points", async () => {
    mocks.listTeams.mockResolvedValue([
      { slug: "z", name: "Zulu", members: ["ada"] },
      { slug: "a", name: "Alfa", members: ["bob"] },
    ]);

    const out = await withTeamStandings(empty());

    expect(out.teams.map((t) => [t.name, t.points, t.rank])).toEqual([
      ["Alfa", 0, 1],
      ["Zulu", 0, 2],
    ]);
  });

  it("leaves the teams at zero when the team totals read fails", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
    mocks.getTeamQuizTotalsBatch.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withTeamStandings(empty());
      // Missing, never wrong: the row still renders, with no invented figure.
      expect(out.teams.map((t) => [t.slug, t.points])).toEqual([["red", 0]]);
      expect(out.teams[0].modules?.["quiz"]).toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });

  // The same split the individual path keeps: the question list is only the
  // "answered / total" denominator, so losing it must never cost a team its
  // points or re-order the board.
  it("keeps team points and order when only the question list fails", async () => {
    mocks.listTeams.mockResolvedValue([
      { slug: "z", name: "Zulu", members: ["ada"] },
      { slug: "a", name: "Alfa", members: ["bob"] },
    ]);
    totalsByMember({ ada: totals(40, 4), bob: totals(10, 1) });
    mocks.listQuestions.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withTeamStandings(empty());
      expect(out.teams.map((t) => [t.name, t.points])).toEqual([
        ["Zulu", 40],
        ["Alfa", 10],
      ]);
      // Only the denominator degrades, and never below its own numerator.
      expect(out.teams[0].modules!["quiz"]!.detail).toEqual({
        kind: "quiz",
        answered: 4,
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
    expect(mocks.getTeamQuizTotalsBatch).not.toHaveBeenCalled();
  });

  // A source that already provides deduped team rows (mock/lambda) had its
  // quiz points added by withModuleContributions one step earlier; this
  // overlay must not touch them a second time.
  it("no-ops on a source that already carries teams, so points are never added twice", async () => {
    const base: LeaderboardData = {
      ...empty(),
      teams: [{ rank: 1, slug: "red", name: "Red", captain: "ada", points: 50, members: ["ada"] }],
      capabilities: { apps: true, teams: true, challenges: false },
    };

    const out = await withTeamStandings(base);

    expect(out).toBe(base);
    expect(mocks.getTeamQuizTotalsBatch).not.toHaveBeenCalled();
  });
});
