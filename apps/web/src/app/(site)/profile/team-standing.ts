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
import { attachNames } from "@/lib/leaderboard/names";

type TeamPanelData = {
  standing: TeamStanding | null;
  /** One entry per roster member, in roster order; null when that member has
   *  no scored activity yet. */
  memberEntries: TeamMemberEntry[];
};

export type TeamMemberEntry = { playerId: string; name: string; image: string | null; entry: LeaderboardEntry | null };

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
    // Matched case-insensitively, like every other player join in this
    // codebase, so a key stored in another case still finds its row.
    // Names come from one profile read over the roster.
    const memberEntries = await attachNames(
      roster.map((member) => ({
        playerId: member,
        entry: data.entries.find((e) => e.playerId.toLowerCase() === member.toLowerCase()) ?? null,
      })),
    );
    return { standing, memberEntries };
  } catch {
    return { standing: null, memberEntries: [] };
  }
}
