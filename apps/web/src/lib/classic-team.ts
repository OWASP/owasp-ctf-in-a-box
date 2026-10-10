// Stories (#463) unlock per TEAM: a step opens once ANY current teammate has
// solved the one before it. These resolve "the team's classic solves" the same
// way the leaderboard folds team solves (the members' own solves hashes), so a
// story unlock and a team's score never disagree about what the team solved.
//
// The roster itself comes from `team-members.ts`, which owns the "team of one,
// viewer first, deduped on the EXACT string" rule for every grading path (the
// shared attempt cap and cooldown count the same team). A solves-read error
// THROWS, so callers fail closed. A TEAM-read error is read as "team of one"
// by getViewerTeam itself — which is also closed (fewer unlocks, never more).

import "server-only";
import { classicSolvesKey } from "@/lib/classic-keys";
import { teamLogins } from "@/lib/team-members";
import { upstashPipeline } from "@/lib/upstash";

/** The solves-hash keys of every current teammate (the viewer first). */
export async function teamSolveKeys(login: string): Promise<string[]> {
  return (await teamLogins(login)).map(classicSolvesKey);
}

/** Every classic challenge id any current teammate has solved. */
export async function getTeamClassicSolvedIds(login: string): Promise<Set<string>> {
  const keys = await teamSolveKeys(login);
  const replies = await upstashPipeline(keys.map((k) => ["HKEYS", k]));
  const solved = new Set<string>();
  for (const r of replies) {
    if (r.error) throw new Error(`team solves read failed: ${r.error}`);
    if (Array.isArray(r.result)) for (const id of r.result) if (typeof id === "string") solved.add(id);
  }
  return solved;
}
