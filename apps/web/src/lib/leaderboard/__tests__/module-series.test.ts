// Issue #415. The chart plotted the SOURCE's history alone — secure-development
// scoring events — while the rows counted every module, so a contestant with
// 202 points had a line sitting at 2 and the board contradicted its own chart.
//
// These pin the merge itself: the app-side modules' per-item `{points, at}`
// become events, they join the source's cumulative series in time order, and a
// team's line is the union of its members' items rather than their sum.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData, LeaderboardEntry, TeamStanding } from "../types";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getEnabledModuleIds: vi.fn(),
  upstashPipeline: vi.fn(),
}));

vi.mock("@/lib/enabled-modules", () => ({ getEnabledModuleIds: mocks.getEnabledModuleIds }));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import { withModuleSeries } from "../module-series";

/** An HGETALL reply: flat [field, value, …], value being the stores' JSON. */
function hash(...items: [string, number, string][]) {
  return { result: items.flatMap(([id, points, at]) => [id, JSON.stringify({ points, at })]) };
}

function entry(login: string, points: number): LeaderboardEntry {
  return { rank: 0, login, team: null, points, patched: 0, failed: 0, total: 0, apps: {}, updatedAt: null };
}

function team(slug: string, members: string[]): TeamStanding {
  return { rank: 1, slug, name: slug, captain: members[0] ?? "", members, points: 0 };
}

function data(overrides: Partial<LeaderboardData> = {}): LeaderboardData {
  return {
    entries: [entry("ada", 10)],
    teams: [],
    series: [],
    teamSeries: [],
    generatedAt: "2026-07-07T00:00:00.000Z",
    capabilities: { apps: true, teams: false, challenges: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEnabledModuleIds.mockResolvedValue(new Set(["secure-development", "quiz"]));
});

describe("withModuleSeries", () => {
  it("charts a contestant whose points are entirely app-side — the reported bug", async () => {
    // No scorer history at all: before this overlay they had no line, or a flat
    // one, while their row showed real points.
    mocks.upstashPipeline.mockResolvedValueOnce([hash(["q1", 40, "2026-01-01T10:00:00.000Z"])]);
    const result = await withModuleSeries(data());
    expect(result.series?.[0].points).toEqual([{ t: "2026-01-01T10:00:00.000Z", score: 40 }]);
  });

  it("merges module events into the source's history in time order, not onto the end", async () => {
    // The source's series is CUMULATIVE, so a module event landing between two
    // of its points has to lift everything after it — appending would draw a
    // line that disagrees with the tooltip riding its steps.
    const base = data({
      series: [
        {
          login: "ada",
          points: [
            { t: "2026-01-01T09:00:00.000Z", score: 5 },
            { t: "2026-01-01T11:00:00.000Z", score: 8 },
          ],
        },
      ],
    });
    mocks.upstashPipeline.mockResolvedValueOnce([hash(["q1", 40, "2026-01-01T10:00:00.000Z"])]);
    const result = await withModuleSeries(base);
    expect(result.series?.[0].points).toEqual([
      { t: "2026-01-01T09:00:00.000Z", score: 5 },
      { t: "2026-01-01T10:00:00.000Z", score: 45 },
      { t: "2026-01-01T11:00:00.000Z", score: 48 },
    ]);
  });

  it("unions a team's items rather than summing members, keeping the earliest", async () => {
    // Two teammates holding the same question is ONE event at the earlier time
    // — the rule the team TOTALS already use. Summing would end the line above
    // the number in the team's own row.
    const base = data({
      entries: [entry("ada", 10), entry("bob", 10)],
      teams: [team("red", ["ada", "bob"])],
      capabilities: { apps: true, teams: true, challenges: false },
    });
    mocks.upstashPipeline.mockResolvedValueOnce([
      hash(["shared", 40, "2026-01-01T12:00:00.000Z"]),
      hash(["shared", 40, "2026-01-01T10:00:00.000Z"], ["own", 5, "2026-01-01T13:00:00.000Z"]),
    ]);
    const result = await withModuleSeries(base);
    expect(result.teamSeries?.[0].points).toEqual([
      { t: "2026-01-01T10:00:00.000Z", score: 40 },
      { t: "2026-01-01T13:00:00.000Z", score: 45 },
    ]);
  });

  it("drops a malformed record instead of losing the whole line", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          "q1",
          "not json",
          "q2",
          JSON.stringify({ points: 7, at: "nonsense" }),
          "q3",
          JSON.stringify({ points: 3, at: "2026-01-01T10:00:00.000Z" }),
        ],
      },
    ]);
    const result = await withModuleSeries(data());
    expect(result.series?.[0].points).toEqual([{ t: "2026-01-01T10:00:00.000Z", score: 3 }]);
  });

  it("reads a per-command error as no events, never as a score", async () => {
    // upstashPipeline does not throw on a per-command failure — it returns the
    // error positionally, and reading `.result` past it would invent a zero.
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    const base = data({ series: [{ login: "ada", points: [{ t: "2026-01-01T09:00:00.000Z", score: 5 }] }] });
    const result = await withModuleSeries(base);
    expect(result.series?.[0].points).toEqual([{ t: "2026-01-01T09:00:00.000Z", score: 5 }]);
  });

  it("leaves the board alone when Upstash is unavailable", async () => {
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("down"));
    const base = data();
    expect(await withModuleSeries(base)).toBe(base);
  });

  it("reads nothing when no app-side module is enabled", async () => {
    mocks.getEnabledModuleIds.mockResolvedValue(new Set(["secure-development"]));
    const base = data();
    expect(await withModuleSeries(base)).toBe(base);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("never touches points — the chart is gross, the row stays net", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([hash(["q1", 40, "2026-01-01T10:00:00.000Z"])]);
    const result = await withModuleSeries(data());
    expect(result.entries[0].points).toBe(10);
  });
});
