// Unit tests for the hint-penalty overlay: penalties subtract from points
// (floored at 0), entries re-rank, and every no-op/degrade path leaves the
// source data untouched.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData, LeaderboardEntry, TeamStanding } from "../types";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const mocks = vi.hoisted(() => ({
  getHintPenalties: vi.fn<() => Promise<Map<string, number>>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/hint-store", () => ({
  getHintPenalties: mocks.getHintPenalties,
  HINTS_AVAILABLE: true,
}));

import { withHintPenalties } from "../hint-penalties";

function entry(login: string, points: number, lastSolveAt?: string): LeaderboardEntry {
  return { rank: 0, login, team: null, points, patched: 0, failed: 0, total: 0, apps: {}, updatedAt: null, lastSolveAt };
}

function data(entries: LeaderboardEntry[]): LeaderboardData {
  return {
    entries: entries.map((e, i) => ({ ...e, rank: i + 1 })),
    teams: [],
    generatedAt: "2026-07-13T00:00:00.000Z",
    capabilities: { apps: false, teams: false, challenges: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withHintPenalties", () => {
  it("subtracts penalties and re-ranks the affected entries", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 70]]));
    const result = await withHintPenalties(data([entry("ada", 100), entry("bob", 40)]));
    expect(result.entries.map((e) => [e.login, e.points, e.rank])).toEqual([
      ["bob", 40, 1],
      ["ada", 30, 2],
    ]);
  });

  it("floors a penalized score at 0 instead of going negative", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["newbie", 30]]));
    const result = await withHintPenalties(data([entry("ada", 10), entry("newbie", 20)]));
    const newbie = result.entries.find((e) => e.login === "newbie")!;
    expect(newbie.points).toBe(0);
    expect(newbie.hintPenalty).toBe(30);
  });

  it("marks only penalized entries with hintPenalty", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["bob", 10]]));
    const result = await withHintPenalties(data([entry("ada", 100), entry("bob", 40)]));
    expect(result.entries.find((e) => e.login === "ada")!.hintPenalty).toBeUndefined();
    expect(result.entries.find((e) => e.login === "bob")!.hintPenalty).toBe(10);
  });

  it("breaks a penalty-created point tie by earlier lastSolveAt", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 10]]));
    // ada drops from 50 to 40, tying bob — but ada's last solve is later, so
    // bob (who reached 40 first) takes the higher rank despite source order.
    const result = await withHintPenalties(
      data([entry("ada", 50, "2026-08-07T15:00:00Z"), entry("bob", 40, "2026-08-07T12:00:00Z")]),
    );
    expect(result.entries.map((e) => [e.login, e.rank])).toEqual([
      ["bob", 1],
      ["ada", 2],
    ]);
  });

  it("keeps the source order on point ties (stable re-rank)", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 10]]));
    // ada drops from 50 to 40, tying bob — ada came first in the source, so
    // she keeps the higher rank.
    const result = await withHintPenalties(data([entry("ada", 50), entry("bob", 40), entry("cyd", 40)]));
    expect(result.entries.map((e) => e.login)).toEqual(["ada", "bob", "cyd"]);
  });

  it("sums case-variant spend fields instead of keeping only the last", async () => {
    // ctf:hints:spent accumulates historically: a case-only GitHub login
    // rename mid-event leaves one person's spend split across two fields.
    // The fold must charge all of it, not whichever field HGETALL yielded
    // last.
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["Ada", 10], ["ada", 20]]));
    const result = await withHintPenalties(data([entry("ada", 100)]));
    expect(result.entries[0].points).toBe(70);
    expect(result.entries[0].hintPenalty).toBe(30);
  });

  it("matches a penalty to its row case-insensitively, like every other login join", async () => {
    // The scorer records the PR author's spelling of the login; the hint
    // purchase records the session's. module-contributions already unions the
    // two spellings into ONE row — the penalty must land on that row too, or
    // a case disagreement makes the hints free on the scored row.
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 30]]));
    const result = await withHintPenalties(data([entry("Ada", 100)]));
    expect(result.entries[0].points).toBe(70);
    expect(result.entries[0].hintPenalty).toBe(30);
  });

  it("no-ops when nobody has bought hints", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map());
    const base = data([entry("ada", 100)]);
    expect(await withHintPenalties(base)).toBe(base);
  });

  it("degrades to the penalty-free view when Upstash is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Decorated like a driver's error: the log gets the label, never the
      // caught value's `command`/`cause` (#500 follow-up).
      mocks.getHintPenalties.mockRejectedValueOnce(decoratedError());
      const base = data([entry("ada", 100)]);
      expect(await withHintPenalties(base)).toBe(base);
      expectLabelOnly(consoleError);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// The teams view is the DEFAULT board when teams exist, so leaving team totals
// unpenalised would make hints effectively free on the primary leaderboard.
describe("withHintPenalties — teams", () => {
  const team = (slug: string, points: number, members: string[]): TeamStanding => ({
    rank: 0,
    slug,
    name: slug,
    captain: members[0] ?? "",
    points,
    members,
  });
  const withTeams = (entries: LeaderboardEntry[], teams: TeamStanding[]): LeaderboardData => ({
    ...data(entries),
    teams: teams.map((t, i) => ({ ...t, rank: i + 1 })),
    capabilities: { apps: true, teams: true, challenges: false },
  });

  it("charges a team the SUM of its members' hint spend and re-ranks", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 30], ["bob", 25]]));
    const result = await withHintPenalties(
      withTeams(
        [entry("ada", 100), entry("bob", 100), entry("cyd", 90)],
        [team("red", 200, ["ada", "bob"]), team("blue", 150, ["cyd"])],
      ),
    );
    // red: 200 - (30 + 25) = 145, which drops it below blue's untouched 150.
    expect(result.teams.map((t) => [t.slug, t.points, t.rank])).toEqual([
      ["blue", 150, 1],
      ["red", 145, 2],
    ]);
  });

  it("exposes the deducted total as hintPenalty for the transparency chip", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 30], ["bob", 25]]));
    const result = await withHintPenalties(
      withTeams([entry("ada", 100)], [team("red", 200, ["ada", "bob"])]),
    );
    expect(result.teams[0].hintPenalty).toBe(55);
  });

  it("floors a team at 0 rather than going negative", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 500]]));
    const result = await withHintPenalties(withTeams([entry("ada", 10)], [team("red", 10, ["ada"])]));
    expect(result.teams[0].points).toBe(0);
  });

  it("leaves a team whose members bought nothing untouched (no hintPenalty field)", async () => {
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["zed", 40]]));
    const result = await withHintPenalties(
      withTeams([entry("ada", 100)], [team("red", 200, ["ada", "bob"])]),
    );
    expect(result.teams[0].points).toBe(200);
    expect(result.teams[0].hintPenalty).toBeUndefined();
  });

  it("charges a member's spend to the team case-insensitively", async () => {
    // The roster stores the spelling the team join recorded; the spend hash
    // stores the session's at purchase time. A disagreement must not exempt
    // the team — the teams view is the DEFAULT board when teams exist.
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 30]]));
    const result = await withHintPenalties(
      withTeams([entry("Ada", 100)], [team("red", 200, ["Ada"])]),
    );
    expect(result.teams[0].points).toBe(170);
    expect(result.teams[0].hintPenalty).toBe(30);
  });

  it("charges a hint bought by two teammates twice — hints are per-person", async () => {
    // Deliberate asymmetry with flag scoring, where a shared flag counts once.
    mocks.getHintPenalties.mockResolvedValueOnce(new Map([["ada", 10], ["bob", 10]]));
    const result = await withHintPenalties(
      withTeams([entry("ada", 50)], [team("red", 100, ["ada", "bob"])]),
    );
    expect(result.teams[0].points).toBe(80);
  });
});
