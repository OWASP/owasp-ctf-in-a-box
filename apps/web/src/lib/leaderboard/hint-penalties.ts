import "server-only";
import { errorLabel } from "@/lib/error-label";
// From hint-config, not hint-store: the store imports this fold (through
// hint-balance.ts, for the affordability gate, #553), so the policy reads the
// fold needs live in a leaf both can import without a cycle.
import { getHintPenalties, HINTS_AVAILABLE } from "@/lib/hint-config";
import { compareStanding, compareTeamStanding } from "./rank";
import type { LeaderboardData } from "./types";

/**
 * Subtracts hint spend (ctf:hints:spent) from displayed points as an overlay —
 * the scorer's data is never mutated, so penalties survive re-scores. Scores
 * are floored at 0 and both boards are re-ranked.
 *
 * THE LAST ROW-TOTAL STAGE BEFORE TEAM ADJUSTMENTS, deliberately: the
 * penalty nets the FINAL all-module total. It used to run first, netting
 * scorer points alone —
 * which made hints free in every case where the row's points arrived later:
 * a classic- or quiz-only contestant (row created by module contributions),
 * and a team whose module points team standings folds in (source rows alike,
 * plus the membership-only rows it synthesises). Module blocks
 * everywhere show GROSS module points; the penalty appears exactly once, at
 * the row level, as the −N hints marker.
 *
 * Applies to teams as well as individuals, because the teams view is the
 * DEFAULT board whenever teams exist: leaving team totals unpenalised would
 * make hints effectively free on the primary leaderboard, which is the whole
 * thing the price exists to prevent.
 *
 * A team's penalty is the SUM of its members' spend. Note the deliberate
 * asymmetry with flag scoring: a flag solved by two teammates counts once
 * (the scorer dedupes the union), but a hint bought by two teammates is
 * charged twice — hints are individually purchased, so redundant buying is
 * the team's own coordination cost. Summing also preserves historical
 * pricing, since ctf:hints:spent stores points rather than a count.
 *
 * Note this overlays STANDINGS only, not `series`/`teamSeries`: the chart is
 * a timeline of solve events, not current standing.
 *
 * Upstash trouble degrades to the penalty-free view rather than failing the
 * whole leaderboard.
 */
export async function withHintPenalties(data: LeaderboardData): Promise<LeaderboardData> {
  // Capability only — a deployment with no Upstash credentials skips the call
  // entirely. Whether the organizer has hints ON is decided inside
  // getHintPenalties (via resolveHintConfig), so this cannot disagree with the
  // /admin toggle the way a second env read would.
  if (!HINTS_AVAILABLE) return data;

  let penalties: Map<string, number>;
  try {
    penalties = await getHintPenalties();
  } catch (err) {
    console.error("hint penalties unavailable:", errorLabel(err));
    return data;
  }
  if (penalties.size === 0) return data;

  // Player ids are matched case-insensitively, like every other player id
  // join in this codebase (module-contributions, team-standings). Kit ids are
  // lowercase, so the fold is the identity on them; a case disagreement still
  // must not exempt the row, since the union fold upstream merges case
  // variants into ONE row and the penalty has to land on it. Case-variant
  // fields are SUMMED, not last-wins: the spend hash accumulates, so every
  // field that folds to one player is that player's spend.
  const byPlayer = new Map<string, number>();
  for (const [playerId, points] of penalties) {
    const key = playerId.toLowerCase();
    byPlayer.set(key, (byPlayer.get(key) ?? 0) + points);
  }

  const entries = data.entries
    .map((entry, i) => {
      const penalty = byPlayer.get(entry.playerId.toLowerCase()) ?? 0;
      return {
        // Original position breaks any tie compareStanding can't (equal
        // points and no lastSolveAt), keeping the source order.
        i,
        entry:
          penalty > 0
            ? { ...entry, points: Math.max(0, entry.points - penalty), hintPenalty: penalty }
            : entry,
      };
    })
    .sort((a, b) => compareStanding(a.entry, b.entry) || a.i - b.i)
    .map(({ entry }, i) => ({ ...entry, rank: i + 1 }));

  const teams = data.teams
    .map((team, i) => {
      const penalty = team.members.reduce((sum, m) => sum + (byPlayer.get(m.toLowerCase()) ?? 0), 0);
      return {
        i,
        team:
          penalty > 0
            ? { ...team, points: Math.max(0, team.points - penalty), hintPenalty: penalty }
            : team,
      };
    })
    // The team rule: points, items, then whoever earned their last
    // points first in any module; the original position holds what is left.
    .sort((a, b) => compareTeamStanding(a.team, b.team) || a.i - b.i)
    .map(({ team }, i) => ({ ...team, rank: i + 1 }));

  return { ...data, entries, teams };
}
