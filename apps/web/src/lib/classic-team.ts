// Stories (#463) unlock per TEAM: a step opens once ANY current teammate has
// solved the one before it. These resolve "the team's classic solves" the same
// way the leaderboard folds team solves (the members' own solves hashes), so a
// story unlock and a team's score never disagree about what the team solved.
//
// A viewer with no team is a team of one. Logins join case-insensitively (the
// AGENTS.md rule): the viewer's own spelling is always included, and members
// are deduped on their lowercased form. A read error THROWS, so every caller's
// fail-CLOSED direction applies (a lock read never guesses "nothing solved"
// silently, and never "everything").

import "server-only";
import { classicSolvesKey } from "@/lib/classic-keys";
import { getViewerTeam } from "@/lib/team-store";
import { upstashPipeline } from "@/lib/upstash";

/** The solves-hash keys of every current teammate (the viewer first). */
export async function teamSolveKeys(login: string): Promise<string[]> {
  const team = await getViewerTeam(login);
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const member of [login, ...(team?.members ?? [])]) {
    const fold = member.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    logins.push(member);
  }
  return logins.map(classicSolvesKey);
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
