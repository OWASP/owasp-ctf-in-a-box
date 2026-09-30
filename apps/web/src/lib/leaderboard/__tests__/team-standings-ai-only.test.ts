// withTeamStandings on an AI-ONLY event: the source has no team concept (and
// no rows at all), so every team row on the board is one this overlay
// synthesises from membership. Mirrors team-standings-quiz-only.test.ts's
// structure — see that file's header for the rationale.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["ai"]),
);

const mocks = vi.hoisted(() => ({
  listTeams: vi.fn<() => Promise<{ slug: string; name: string; members: string[] }[]>>(),
  getAiTotals: vi.fn(),
  getTeamAiTotalsBatch: vi.fn(),
  listAiChallenges: vi.fn(),
}));

vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/ai-store", () => ({
  getAiTotals: mocks.getAiTotals,
  getTeamAiTotalsBatch: mocks.getTeamAiTotalsBatch,
  listAiChallenges: mocks.listAiChallenges,
}));

import { withModuleContributions } from "../module-contributions";
import { withTeamStandings } from "../team-standings";

const totals = (points: number, solved: number, lastAt: string | null = null) => ({ points, solved, lastAt });

/** Stubs the batch keyed on each team's FIRST MEMBER rather than on
 *  position — see the quiz-only sibling's identical helper for why. */
function totalsByMember(byMember: Record<string, ReturnType<typeof totals>>) {
  mocks.getTeamAiTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map((members) => byMember[members[0]] ?? totals(0, 0))),
  );
}

/** Exactly what `emptySource` hands the pipeline on an ai-only event. */
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
  mocks.getAiTotals.mockResolvedValue(new Map());
  mocks.listAiChallenges.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
  mocks.getTeamAiTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => totals(0, 0))),
  );
});

describe("withTeamStandings on an ai-only event", () => {
  it("ranks synthesised teams by their real ai points, not alphabetically", async () => {
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
    expect(out.teams[0].modules!["ai"]).toMatchObject({ points: 40, completed: 4 });
  });

  // The established team rule: a team's ai total is the UNION of the
  // challenges its members solved, so a challenge two teammates both solved
  // counts ONCE. That fold lives in getTeamAiTotalsBatch — this overlay must
  // USE it and must never re-derive a team score by summing member
  // aggregates.
  it("takes the deduped team total rather than summing member points", async () => {
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada", "cyd"] }]);
    // Both members banked the SAME 30-point challenge: 30 as a team, 60 summed.
    mocks.getAiTotals.mockResolvedValue(
      new Map([
        ["ada", totals(30, 1)],
        ["cyd", totals(30, 1)],
      ]),
    );
    mocks.getTeamAiTotalsBatch.mockResolvedValue([totals(30, 1)]);

    const out = await pipeline(empty());

    expect(mocks.getTeamAiTotalsBatch).toHaveBeenCalledTimes(1);
    expect(mocks.getTeamAiTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"]]);
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

    expect(mocks.getTeamAiTotalsBatch).toHaveBeenCalledTimes(1);
    expect(out.teams.map((t) => [t.slug, t.points])).toEqual([
      ["red", 30],
      ["blue", 20],
      ["grey", 0],
    ]);
    // A team with no solves gets no block rather than an empty one.
    expect(out.teams.find((t) => t.slug === "grey")!.modules?.["ai"]).toBeUndefined();
  });

  it("attributes a member whose casing differs from the membership record", async () => {
    mocks.getAiTotals.mockResolvedValue(new Map([["Ada", totals(30, 3)]]));
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
    mocks.getTeamAiTotalsBatch.mockResolvedValue([totals(30, 3)]);

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
    mocks.getTeamAiTotalsBatch.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withTeamStandings(empty());
      expect(out.teams.map((t) => [t.slug, t.points])).toEqual([["red", 0]]);
      expect(out.teams[0].modules?.["ai"]).toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });

  it("keeps team points and order when only the challenge list fails", async () => {
    mocks.listTeams.mockResolvedValue([
      { slug: "z", name: "Zulu", members: ["ada"] },
      { slug: "a", name: "Alfa", members: ["bob"] },
    ]);
    totalsByMember({ ada: totals(40, 4), bob: totals(10, 1) });
    mocks.listAiChallenges.mockRejectedValue(new Error("upstash blip"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await withTeamStandings(empty());
      expect(out.teams.map((t) => [t.name, t.points])).toEqual([
        ["Zulu", 40],
        ["Alfa", 10],
      ]);
      expect(out.teams[0].modules!["ai"]!.detail).toEqual({
        kind: "ai",
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
    expect(mocks.getTeamAiTotalsBatch).not.toHaveBeenCalled();
  });

  // A source that already provides deduped team rows (mock/lambda) gets its
  // ai points from THIS stage and no other. withModuleContributions used to
  // add them one step earlier as well, and with this overlay on top every
  // scorer team counted them twice (issue #520). An empty team store must
  // not skip them either — this is the only place they are added.
  it("adds a source team's ai points exactly once, even with an empty team store", async () => {
    mocks.listTeams.mockResolvedValue([]);
    totalsByMember({ ada: totals(40, 4) });
    const base: LeaderboardData = {
      ...empty(),
      teams: [{ rank: 1, slug: "red", name: "Red", captain: "ada", points: 50, members: ["ada"] }],
      capabilities: { apps: true, teams: true, challenges: false },
    };

    const out = await pipeline(base);

    expect(out.teams.map((t) => [t.slug, t.points])).toEqual([["red", 90]]);
    expect(out.teams[0].modules?.ai?.points).toBe(40);
    expect(mocks.getTeamAiTotalsBatch).toHaveBeenCalledTimes(1);
  });
});

// Issue #348: the same contestant's same module read "5 / 5 cleared" on the
// board and "5 / 7 cleared" on their profile, because the team row counted
// against the LIVE catalogue while the profile counted the union. The board's
// fold already dedupes members' solves by item id, so the ids needed to union
// were in hand all along — they just weren't carried out of it.
describe("a team row's denominator counts the union, not the live catalogue", () => {
  const withIds = (points: number, solved: number, itemIds: string[]) => ({
    points,
    solved,
    lastAt: null,
    itemIds,
  });

  /** The ai module block the board built for the one team on it. */
  async function aiDetail(total: ReturnType<typeof withIds>) {
    mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
    mocks.getTeamAiTotalsBatch.mockResolvedValue([total]);
    const out = await pipeline(empty());
    const detail = out.teams[0].modules?.ai?.detail;
    if (detail?.kind !== "ai") throw new Error("expected an ai detail block");
    return detail;
  }

  it("ADDS challenges the team solved that an organizer has since deleted", async () => {
    // Catalogue a1..a3; the team solved a1 plus two challenges that are gone.
    const detail = await aiDetail(withIds(870, 3, ["a1", "deleted-1", "deleted-2"]));
    expect(detail.solved).toBe(3);
    // 5, not 3: two live challenges are still open and two banked solves have
    // no live challenge behind them. Reading "3 / 3" would call the module
    // finished with two challenges left on it.
    expect(detail.total).toBe(5);
    expect(detail.total).toBeGreaterThan(detail.solved);
  });

  it("leaves an untouched catalogue at its own size", async () => {
    // The case that hid the bug for three releases: with nothing deleted the
    // union and the live count are the same number.
    const detail = await aiDetail(withIds(100, 1, ["a1"]));
    expect(detail.total).toBe(3);
  });

  it("never reports a team as having solved more than the board holds", async () => {
    // Every id live: the union must not inflate past the catalogue.
    const detail = await aiDetail(withIds(300, 3, ["a1", "a2", "a3"]));
    expect(detail.total).toBe(3);
    expect(detail.solved).toBe(3);
  });

  it("clamps rather than orphaning every solve when the catalogue read fails", async () => {
    // A failed `listAiChallenges` degrades to a missing denominator on
    // purpose. Counting all three solves as orphans would read "3 / 3" — the
    // same false "finished" by a different route.
    mocks.listAiChallenges.mockRejectedValue(new Error("upstash down"));
    const detail = await aiDetail(withIds(300, 3, ["a1", "a2", "a3"]));
    expect(detail.total).toBe(3);
  });
});
