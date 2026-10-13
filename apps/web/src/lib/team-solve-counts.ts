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
//
// `teamSolveBoard` (#188) is the same read with HGETALL in place of HKEYS, so
// the classic board also gets each challenge's FIRST BLOOD out of the very
// rows it counts: the earliest solve among the current members, by the rule
// in first-blood.ts. Derived like the count, so it has the count's
// properties: a progress reset (which deletes the solves hash) or a member
// leaving the team (deleted, or removed in the Support tab) takes their first
// bloods with them, and nothing is left to clean up.

import "server-only";
import { aiSolvesKey } from "@/lib/ai-keys";
import { classicSolvesKey } from "@/lib/classic-keys";
import { errorLabel } from "@/lib/error-label";
import { earlierFirstBlood, type FirstBlood } from "@/lib/first-blood";
import { parseJsonValue } from "@/lib/redis-decode";
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
      // HKEYS of a missing hash is [], so anything else is a read that did
      // not happen, not a member with no solves.
      if (!Array.isArray(reply?.result)) throw new Error(`HKEYS reply ${i} missing or not a list`);
      const ids = reply.result as unknown[];
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

/** The board's per-challenge facts from one read: how many teams solved each
 *  challenge, and who solved it first. */
export type TeamSolveBoard = { counts: Map<string, number>; firstBlood: Map<string, FirstBlood> };

/** `teamSolveCounts` plus first blood (#188), from one HGETALL per current
 *  team member. Null when any read failed, for the same reason as the count:
 *  a first blood picked from a short read can name the wrong contestant, and
 *  a wrong name reads as a real one. */
export async function teamSolveBoard(module: "classic" | "ai"): Promise<TeamSolveBoard | null> {
  try {
    const teams = await listTeams();
    const members = teams.flatMap((t) => t.members.map((login) => ({ team: t.slug, login })));
    const board: TeamSolveBoard = { counts: new Map(), firstBlood: new Map() };
    if (members.length === 0) return board;
    const replies = await upstashPipeline(members.map(({ login }) => ["HGETALL", SOLVES_KEY[module](login)]));
    const solvedBy = new Map<string, Set<string>>();
    members.forEach(({ team, login }, i) => {
      const reply = replies[i];
      if (reply?.error) throw new Error(reply.error);
      // HGETALL of a missing hash is [], so anything else is a read that did
      // not happen, not a member with no solves.
      if (!Array.isArray(reply?.result)) throw new Error(`HGETALL reply ${i} missing or not a list`);
      const flat = reply.result as unknown[];
      for (let j = 0; j < flat.length; j += 2) {
        const id = flat[j];
        if (typeof id !== "string") continue;
        const set = solvedBy.get(id) ?? new Set<string>();
        set.add(team);
        solvedBy.set(id, set);
        // A row whose time cannot be read is still a solve (it counts), and
        // ranks after every timed one (first-blood.ts).
        const at = parseJsonValue(flat[j + 1], (row) => (typeof row.at === "string" ? row.at : null));
        board.firstBlood.set(id, earlierFirstBlood(board.firstBlood.get(id), { login, at }));
      }
    });
    for (const [id, set] of solvedBy) board.counts.set(id, set.size);
    return board;
  } catch (err) {
    console.error(`team solve board (${module}) unavailable:`, errorLabel(err));
    return null;
  }
}
