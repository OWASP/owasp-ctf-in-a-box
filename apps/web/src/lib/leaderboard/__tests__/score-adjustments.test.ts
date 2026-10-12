// Score adjustments fold into each TEAM's total, last, after hint penalties
// (#591): a team-only bonus or penalty, the total floored at 0 like the hint
// fold, teams re-ranked, and the tie-break time left alone (an adjustment
// moves points, not "who got there first").
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData, TeamStanding } from "../types";

const m = vi.hoisted(() => ({ teamAdjustments: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/adjustments-store", () => ({ teamAdjustments: m.teamAdjustments }));

import { withScoreAdjustments } from "../score-adjustments";

const team = (slug: string, points: number, lastSolveAt: string): TeamStanding => ({
  rank: 0,
  slug,
  name: slug,
  captain: `${slug}-1`,
  members: [`${slug}-1`],
  points,
  lastSolveAt,
});

const data = (teams: TeamStanding[]): LeaderboardData => ({
  entries: [],
  teams: teams.map((t, i) => ({ ...t, rank: i + 1 })),
  generatedAt: "2026-10-09T00:00:00.000Z",
  capabilities: { apps: false, teams: true, challenges: false },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("withScoreAdjustments", () => {
  it("applies each team's net adjustment and re-ranks", async () => {
    m.teamAdjustments.mockResolvedValueOnce(new Map([["blue", 60]]));
    const out = await withScoreAdjustments(data([team("red", 100, "2026-10-09T10:00:00Z"), team("blue", 50, "2026-10-09T10:00:00Z")]));
    expect(out.teams.map((t) => [t.slug, t.points, t.rank, t.adjustment])).toEqual([
      ["blue", 110, 1, 60],
      ["red", 100, 2, undefined],
    ]);
  });

  it("floors a penalised total at 0 and keeps the marker", async () => {
    m.teamAdjustments.mockResolvedValueOnce(new Map([["red", -500]]));
    const out = await withScoreAdjustments(data([team("red", 100, "2026-10-09T10:00:00Z")]));
    expect(out.teams[0]).toMatchObject({ points: 0, adjustment: -500 });
  });

  // Two teams level after an adjustment are ordered by when each earned its
  // last points, not by when the organizer adjusted them.
  it("leaves the tie-break time alone", async () => {
    m.teamAdjustments.mockResolvedValueOnce(new Map([["late", 10]]));
    const out = await withScoreAdjustments(
      data([team("late", 90, "2026-10-09T12:00:00Z"), team("early", 100, "2026-10-09T09:00:00Z")]),
    );
    expect(out.teams.map((t) => [t.slug, t.points, t.lastSolveAt])).toEqual([
      ["early", 100, "2026-10-09T09:00:00Z"],
      ["late", 100, "2026-10-09T12:00:00Z"],
    ]);
  });

  it("touches nothing when there are no adjustments", async () => {
    m.teamAdjustments.mockResolvedValueOnce(new Map());
    const input = data([team("red", 100, "2026-10-09T10:00:00Z")]);
    expect(await withScoreAdjustments(input)).toBe(input);
  });

  // Same direction as the hint fold: the board must render. The failure is
  // logged so the missing adjustment is visible to an operator.
  it("serves the board unadjusted, and logs, when the ledger cannot be read", async () => {
    m.teamAdjustments.mockRejectedValueOnce(new Error("Upstash pipeline failed: HTTP 503"));
    const input = data([team("red", 100, "2026-10-09T10:00:00Z")]);
    expect(await withScoreAdjustments(input)).toBe(input);
    expect(console.error).toHaveBeenCalled();
  });
});
