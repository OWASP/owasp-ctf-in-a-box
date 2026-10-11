// How many TEAMS solved each challenge (#595), for the contestant boards and
// the admin list. Scoring is per team, so the board counts teams: the same
// union the team totals fold (two members solving one flag count once), over
// the members a team has now. A teamless solver is not counted. Derived from
// the members' own solves hashes on every read rather than stored, so a team
// change can never leave it stale. The stored per-challenge figure
// (`ctf:<module>:solvecount`) is distinct PLAYERS, a different question.
//
// One SCAN-backed team list and one pipeline of HKEYS per member: the same
// reads the leaderboard's team fold makes, sized by contestants, not by board.

import "server-only";
import { aiSolvesKey } from "@/lib/ai-keys";
import { classicSolvesKey } from "@/lib/classic-keys";
import { errorLabel } from "@/lib/error-label";
import { listTeams } from "@/lib/team-store";
import { upstashPipeline } from "@/lib/upstash";

const SOLVES_KEY = { classic: classicSolvesKey, ai: aiSolvesKey } as const;

/** Teams that solved each challenge id of `module`, or null when a read
 *  failed: a silently short count reads as a real one, so the caller shows
 *  no count rather than a wrong one. */
export async function teamSolveCounts(module: "classic" | "ai"): Promise<Map<string, number> | null> {
  try {
    const teams = await listTeams();
    const members = teams.flatMap((t) => t.members.map((login) => ({ team: t.slug, login })));
    const counts = new Map<string, number>();
    if (members.length === 0) return counts;
    const replies = await upstashPipeline(members.map(({ login }) => ["HKEYS", SOLVES_KEY[module](login)]));
    const solvedBy = new Map<string, Set<string>>();
    members.forEach(({ team }, i) => {
      const reply = replies[i];
      if (reply?.error) throw new Error(reply.error);
      const ids = Array.isArray(reply?.result) ? (reply.result as unknown[]) : [];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const set = solvedBy.get(id) ?? new Set<string>();
        set.add(team);
        solvedBy.set(id, set);
      }
    });
    for (const [id, set] of solvedBy) counts.set(id, set.size);
    return counts;
  } catch (err) {
    console.error(`team solve counts (${module}) unavailable:`, errorLabel(err));
    return null;
  }
}
