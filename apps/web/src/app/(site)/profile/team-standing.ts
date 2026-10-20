import "server-only";

// The team's scoring picture for the profile's Team progress panel, built from
// the SAME pipeline (and the same overlay order) the public leaderboard runs —
// getLeaderboard → withModuleContributions → withTeamStandings →
// withHintPenalties → withScoreAdjustments — so the panel and the board can never disagree about a
// team's total.
//
// A failed read drops the panel, never the page: this is a progress display,
// not a gate.

import type { LeaderboardEntry, TeamStanding } from "@/lib/leaderboard/types";
import { getLeaderboardSource } from "@/lib/leaderboard/source";
import { withHintPenalties } from "@/lib/leaderboard/hint-penalties";
import { withScoreAdjustments } from "@/lib/leaderboard/score-adjustments";
import { withModuleContributions } from "@/lib/leaderboard/module-contributions";
import { withTeamStandings } from "@/lib/leaderboard/team-standings";

type TeamPanelData = {
  standing: TeamStanding | null;
  /** One entry per roster member, in roster order; null when that member has
   *  no scored activity yet. */
  memberEntries: { login: string; entry: LeaderboardEntry | null }[];
};

export async function loadTeamStanding(
  team: { slug: string; members: string[] } | null,
): Promise<TeamPanelData> {
  if (!team) return { standing: null, memberEntries: [] };
  try {
    const source = await getLeaderboardSource();
    const data = await source
      .getLeaderboard()
      .then(withModuleContributions)
      .then(withTeamStandings)
      .then(withHintPenalties)
      .then(withScoreAdjustments);
    const standing = data.teams.find((t) => t.slug === team.slug) ?? null;
    // The store's roster wins; the standing's member list covers the mock
    // fallback path where `team.members` arrives empty.
    const roster = team.members.length > 0 ? team.members : (standing?.members ?? []);
    // Matched case-insensitively, like every other login join in this
    // codebase: the roster stores the spelling the team join recorded, the
    // board row the scorer's (PR author) — a disagreement must not render a
    // scoring teammate as 0 pts.
    const memberEntries = roster.map((member) => ({
      login: member,
      entry: data.entries.find((e) => e.login.toLowerCase() === member.toLowerCase()) ?? null,
    }));
    return { standing, memberEntries };
  } catch {
    return { standing: null, memberEntries: [] };
  }
}
