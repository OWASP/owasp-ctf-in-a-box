// Unit tests for the team-standings overlay. It cannot dedupe a flag two
// teammates both solved (no per-flag data), so it must never sum member
// totals into a fabricated team score — that's the double-count bug this file
// guards against. Real secure-development team points come from the
// scorer/lambda path, whose rows are therefore KEPT as they arrive.
//
// What it must NOT do is stand aside entirely when that path reports teams:
// the source knows the teams it scored, the team store knows the teams
// contestants created, and one seeded team in the source used to hide every
// real team on the board (issue #413).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData, LeaderboardEntry } from "../types";

const mocks = vi.hoisted(() => ({
  listTeams: vi.fn<() => Promise<{ slug: string; name: string; members: string[] }[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// This suite is secure-development-only — quiz/classic/ai are disabled —
// stated explicitly rather than inherited from the baked double's default,
// so `withTeamQuizPoints`/`withTeamClassicPoints`/`withTeamAiPoints` take the
// quiz/classic/ai-disabled early return instead of reaching their real,
// unmocked stores (which would fail open against no Upstash credentials and
// pass the `[0, 0]` assertions below for the wrong reason).
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => id === "secure-development",
}));
vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));

import { withTeamStandings } from "../team-standings";

function entry(login: string, points: number): LeaderboardEntry {
  return { rank: 0, login, team: null, points, patched: 0, failed: 0, total: 0, apps: {}, updatedAt: null };
}

function data(overrides: Partial<LeaderboardData> = {}): LeaderboardData {
  return {
    entries: [entry("ada", 100), entry("bob", 40), entry("cyd", 25)],
    teams: [],
    generatedAt: "2026-07-07T00:00:00.000Z",
    capabilities: { apps: true, teams: false, challenges: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withTeamStandings", () => {
  it("does NOT sum member points into a fabricated team score (no per-flag data to dedupe with)", async () => {
    mocks.listTeams.mockResolvedValueOnce([
      { slug: "red", name: "Red Team", members: ["bob", "cyd"] }, // would be 65 if (wrongly) summed
      { slug: "blue", name: "Blue Team", members: ["ada"] }, // would be 100 if (wrongly) summed
    ]);
    const result = await withTeamStandings(data());
    expect(result.teams.map((t) => t.points)).toEqual([0, 0]);
  });

  it("attaches the team slug to member entries and leaves solo players alone", async () => {
    mocks.listTeams.mockResolvedValueOnce([{ slug: "red", name: "Red Team", members: ["bob"] }]);
    const result = await withTeamStandings(data());
    expect(result.entries.map((e) => [e.login, e.team])).toEqual([
      ["ada", null],
      ["bob", "red"],
      ["cyd", null],
    ]);
  });

  it("defaults captain to the first member (team-store has no captain field yet)", async () => {
    mocks.listTeams.mockResolvedValueOnce([{ slug: "red", name: "Red Team", members: ["bob", "cyd"] }]);
    const result = await withTeamStandings(data());
    expect(result.teams[0].captain).toBe("bob");
    expect(result.teams[0].members).toEqual(["bob", "cyd"]);
  });

  it("ranks teams alphabetically since no real point figure is available", async () => {
    mocks.listTeams.mockResolvedValueOnce([
      { slug: "z", name: "Zulu", members: ["bob"] },
      { slug: "a", name: "Alfa", members: ["cyd"] },
    ]);
    const result = await withTeamStandings(data());
    expect(result.teams.map((t) => t.name)).toEqual(["Alfa", "Zulu"]);
    expect(result.teams.map((t) => t.rank)).toEqual([1, 2]);
  });

  // Issue #413, and the shape the live event actually failed in: the scorer
  // reported seeded teams, so the organizer's own team of one — created in the
  // app, with a captain and a join code — was dropped from the board entirely.
  it("keeps the source's teams AND adds the ones only the team store knows", async () => {
    const base = data({
      capabilities: { apps: true, teams: true, challenges: true },
      teams: [
        { rank: 1, slug: "byte-me", name: "Byte Me", captain: "ada", members: ["ada"], points: 2108 },
      ],
    });
    mocks.listTeams.mockResolvedValueOnce([{ slug: "dcotelo", name: "dcotelo", members: ["dcotelo"] }]);
    const result = await withTeamStandings(base);
    expect(result.teams.map((t) => t.slug).sort()).toEqual(["byte-me", "dcotelo"]);
  });

  it("does not recompute the source's team points, which are already deduped", async () => {
    const base = data({
      capabilities: { apps: true, teams: true, challenges: true },
      teams: [
        { rank: 1, slug: "byte-me", name: "Byte Me", captain: "ada", members: ["ada", "bob"], points: 2108 },
      ],
    });
    mocks.listTeams.mockResolvedValueOnce([{ slug: "solo", name: "Solo", members: ["cyd"] }]);
    const result = await withTeamStandings(base);
    expect(result.teams.find((t) => t.slug === "byte-me")?.points).toBe(2108);
    // The appended row fabricates nothing, for the same reason as ever.
    expect(result.teams.find((t) => t.slug === "solo")?.points).toBe(0);
  });

  // Review finding on #414. The overlays fold by each row's `members`, so a
  // slug both records claim has to carry the union: keeping the source's
  // roster verbatim would drop a member the scorer never scored, and with them
  // every quiz/classic/ai item they alone hold — an undercount with nothing on
  // screen to suggest it. Asserted on the returned row because that is the
  // exact array the overlays were handed.
  it("unions the rosters when both records claim the same slug", async () => {
    const base = data({
      capabilities: { apps: true, teams: true, challenges: true },
      teams: [{ rank: 1, slug: "red", name: "Red Team", captain: "ada", members: ["ada"], points: 40 }],
    });
    mocks.listTeams.mockResolvedValueOnce([{ slug: "red", name: "Red Team", members: ["bob", "cyd"] }]);
    const result = await withTeamStandings(base);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].members).toEqual(["ada", "bob", "cyd"]);
    // The source's own figure is still the one reported.
    expect(result.teams[0].points).toBe(40);
  });

  it("does not duplicate a member the two records spell differently", async () => {
    const base = data({
      capabilities: { apps: true, teams: true, challenges: true },
      teams: [{ rank: 1, slug: "red", name: "Red Team", captain: "Ada", members: ["Ada"], points: 40 }],
    });
    mocks.listTeams.mockResolvedValueOnce([{ slug: "red", name: "Red Team", members: ["ada"] }]);
    const result = await withTeamStandings(base);
    expect(result.teams[0].members).toEqual(["ada"]);
  });

  it("chips every member, whichever record placed them on a team", async () => {
    const base = data({
      capabilities: { apps: true, teams: true, challenges: true },
      teams: [{ rank: 1, slug: "byte-me", name: "Byte Me", captain: "ada", members: ["ada"], points: 10 }],
    });
    mocks.listTeams.mockResolvedValueOnce([{ slug: "red", name: "Red Team", members: ["bob"] }]);
    const result = await withTeamStandings(base);
    expect(result.entries.map((e) => [e.login, e.team])).toEqual([
      ["ada", "byte-me"],
      ["bob", "red"],
      ["cyd", null],
    ]);
  });

  it("prefers the team store when both records place the same login", async () => {
    const base = data({
      capabilities: { apps: true, teams: true, challenges: true },
      teams: [{ rank: 1, slug: "stale", name: "Stale", captain: "bob", members: ["bob"], points: 5 }],
    });
    mocks.listTeams.mockResolvedValueOnce([{ slug: "current", name: "Current", members: ["bob"] }]);
    const result = await withTeamStandings(base);
    expect(result.entries.find((e) => e.login === "bob")?.team).toBe("current");
  });

  it("no-ops when no teams exist", async () => {
    mocks.listTeams.mockResolvedValueOnce([]);
    const base = data();
    expect(await withTeamStandings(base)).toBe(base);
  });

  it("degrades to the team-less view when Upstash is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listTeams.mockRejectedValueOnce(new Error("upstash down"));
    const base = data();
    expect(await withTeamStandings(base)).toBe(base);
    consoleError.mockRestore();
  });
});
