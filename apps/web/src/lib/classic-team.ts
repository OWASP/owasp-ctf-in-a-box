// Stories (#463) unlock per TEAM: a step opens once a teammate has solved the
// one before it. These resolve "the team's classic solves" from the members'
// own solves hashes, the same records the leaderboard folds team points from.
//
// Solve-time membership (#602, ADR 60): a member's solve opens the next step
// for a team only if they were on that team when they made it, that is, the
// solve's `at` is on or after their `joinedAt`. Membership is otherwise read
// NOW, so without this a player could solve step 3 on team A, join team B and
// open step 4 for B. Points are not affected: a team's total stays the union
// of its members' solves.
//
// A viewer with no team is a team of one: their own solves count. Members are
// deduped on the EXACT string, not the lowercased one: a solves hash is keyed
// on whatever spelling wrote it, so a member stored in a different case keeps
// its own key alongside. A read error THROWS, so callers fail closed. A
// TEAM-read error is read as "team of one" by getViewerTeam itself, which is
// also closed (fewer unlocks, never more), and so is a member record on a
// team with no `joinedAt`.

import "server-only";
import { classicSolvesKey } from "@/lib/classic-keys";
import { userKey } from "@/lib/team-keys";
import { getViewerTeam, TEAM_WRITES_ENABLED } from "@/lib/team-store";
import { upstashPipeline } from "@/lib/upstash";

/** The viewer and every current teammate, viewer first, exact-string deduped.
 *  With team writes off the team is a cookie that no user record names, so
 *  it is evaluated as a team of one: under its slug, the viewer's own solves
 *  would open nothing. */
async function viewerTeam(login: string): Promise<{ team: string; logins: string[] }> {
  const team = await getViewerTeam(login);
  const slug = TEAM_WRITES_ENABLED ? (team?.slug ?? "") : "";
  return { team: slug, logins: [...new Set([login, ...(team?.members ?? [])])] };
}

/** What a grading script's story lock is handed: for each member, their
 *  solves hash then their user record (`team`, `joinedAt`), viewer first; and
 *  the viewer's team slug, "" for a team of one. See `storyLockLua`. */
export async function teamLockKeys(login: string): Promise<{ keys: string[]; team: string }> {
  const { team, logins } = await viewerTeam(login);
  return { team, keys: logins.flatMap((l) => [classicSolvesKey(l), userKey(l)]) };
}

/** Whether one member's solve, stamped `at`, counts toward a team's unlocks.
 *  `team` is the team asked about: a slug, null for a team of one, or
 *  undefined for a board roster (each member's current team). */
function solveUnlocks(at: unknown, memberTeam: string, joinedAt: string, team: string | null | undefined): boolean {
  if (!memberTeam) return team === null || team === undefined;
  if (team !== undefined && memberTeam !== team) return false;
  return Boolean(joinedAt) && typeof at === "string" && at >= joinedAt;
}

/** Every classic challenge id that opens the next story step for `logins`
 *  on `team` (see `solveUnlocks`). ISO-8601 UTC strings, as both records are
 *  written, compare correctly as strings. */
export async function unlockingSolvedIds(logins: string[], team?: string | null): Promise<Set<string>> {
  const [ids] = await unlockingSolvedIdsBatch([{ logins, team }]);
  return ids;
}

/** `unlockingSolvedIds` for MANY rosters in ONE pipeline — the board's form,
 *  one entry per roster, same `solveUnlocks` rule, same fail-closed throw.
 *  A login on more than one roster is fetched ONCE and its replies reused
 *  (the dedupe `getTeamClassicTotalsBatch` does): `/leaderboard` is dynamic
 *  and fetched `no-store`, so one round trip per team would bill a 25-team
 *  event 25 REST calls on every page view. */
export async function unlockingSolvedIdsBatch(
  rosters: readonly { logins: readonly string[]; team?: string | null }[],
): Promise<Set<string>[]> {
  const indexByLogin = new Map<string, number>();
  for (const roster of rosters) {
    for (const login of roster.logins) {
      if (!indexByLogin.has(login)) indexByLogin.set(login, indexByLogin.size);
    }
  }
  const logins = [...indexByLogin.keys()];
  const replies = logins.length
    ? await upstashPipeline(
        logins.flatMap((l) => [
          ["HGETALL", classicSolvesKey(l)],
          ["HMGET", userKey(l), "team", "joinedAt"],
        ]),
      )
    : [];
  const members = logins.map((_, i) => {
    const rows = replies[2 * i];
    const user = replies[2 * i + 1];
    if (rows?.error || user?.error) throw new Error(`team solves read failed: ${rows?.error ?? user?.error}`);
    const [memberTeam, joinedAt] = Array.isArray(user?.result) ? (user.result as unknown[]) : [];
    return {
      flat: Array.isArray(rows?.result) ? (rows.result as unknown[]) : [],
      memberTeam: typeof memberTeam === "string" ? memberTeam : "",
      joinedAt: typeof joinedAt === "string" ? joinedAt : "",
    };
  });
  return rosters.map((roster) => {
    const solved = new Set<string>();
    for (const login of roster.logins) {
      const member = members[indexByLogin.get(login) ?? -1];
      if (!member) continue;
      for (let j = 0; j + 1 < member.flat.length; j += 2) {
        const id = member.flat[j];
        if (typeof id !== "string") continue;
        let at: unknown;
        try {
          at = (JSON.parse(String(member.flat[j + 1])) as { at?: unknown }).at;
        } catch {
          continue;
        }
        if (solveUnlocks(at, member.memberTeam, member.joinedAt, roster.team)) solved.add(id);
      }
    }
    return solved;
  });
}

/** The ids that open the next story step for the viewer's team. */
export async function getTeamClassicSolvedIds(login: string): Promise<Set<string>> {
  const { team, logins } = await viewerTeam(login);
  return unlockingSolvedIds(logins, team || null);
}

/** The story lock as a Lua fragment, shared by the grading and hint scripts
 *  so the two cannot drift. It sets `open` from the pairs `teamLockKeys`
 *  hands in from KEYS[first] on: the prerequisite (ARGV[prereq]) opens the
 *  step if some member's solve row holds it and either the member is on no
 *  team and the viewer is a team of one (ARGV[team] == ''), or the member's
 *  record still names the viewer's team and the solve is no older than their
 *  joinedAt. Decided inside the script, so a join cannot race it. */
export function storyLockLua(first: number, prereq: number, team: number): string {
  return `local open = false
for i = ${first}, #KEYS, 2 do
  local row = redis.call('HGET', KEYS[i], ARGV[${prereq}])
  if row then
    local member = redis.call('HMGET', KEYS[i + 1], 'team', 'joinedAt')
    if not member[1] or member[1] == '' then
      if ARGV[${team}] == '' then open = true break end
    elseif member[1] == ARGV[${team}] and member[2] then
      local at = string.match(row, '"at":"([^"]+)"')
      if at and at >= member[2] then open = true break end
    end
  end
end`;
}
