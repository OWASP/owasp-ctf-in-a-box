import "server-only";

// Organizer score adjustments (adjustments-store.ts) folded into each TEAM's
// total. Runs after withHintPenalties, as the last ranking overlay, so the
// figure a team is ranked on is gross module points, less hint spend, plus or
// minus adjustments.
// Floored at 0 like the hint fold. Re-ranks with the team comparator, whose
// tie-break time is untouched: an adjustment moves points, not "who got
// there first". Individual rows are not adjusted (adjustments are
// team-only), and the score chart stays gross, like it does for hints.
//
// Fails OPEN, like the hint fold: an unreadable ledger serves the board
// unadjusted and logs it, rather than failing the board.

import { teamAdjustments } from "@/lib/adjustments-store";
import { errorLabel } from "@/lib/error-label";
import { compareTeamStanding } from "./rank";
import type { LeaderboardData } from "./types";

export async function withScoreAdjustments(data: LeaderboardData): Promise<LeaderboardData> {
  let bySlug: Map<string, number>;
  try {
    bySlug = await teamAdjustments();
  } catch (err) {
    console.error("score adjustments unavailable, board served unadjusted:", errorLabel(err));
    return data;
  }
  if (bySlug.size === 0) return data;

  const teams = data.teams
    .map((team, i) => {
      const adjustment = bySlug.get(team.slug) ?? 0;
      return {
        i,
        team: adjustment !== 0 ? { ...team, points: Math.max(0, team.points + adjustment), adjustment } : team,
      };
    })
    .sort((a, b) => compareTeamStanding(a.team, b.team) || a.i - b.i)
    .map(({ team }, i) => ({ ...team, rank: i + 1 }));

  return { ...data, teams };
}
