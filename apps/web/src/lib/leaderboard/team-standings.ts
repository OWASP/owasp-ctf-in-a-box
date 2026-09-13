import "server-only";
import { listTeams } from "@/lib/team-store";
import { withTeamAiPoints, withTeamClassicPoints, withTeamQuizPoints } from "./module-contributions";
import type { LeaderboardData, TeamStanding } from "./types";

/**
 * Overlays live team MEMBERSHIP (from the team store's ctf:team:* records)
 * onto leaderboard data from a source that has no team concept (upstash, and
 * the empty source a quiz-only event uses). Such a source only has each
 * player's per-login TOTAL, not which flag earned which point — so it has no
 * way to tell whether two teammates' totals overlap on a flag they both
 * solved. Summing member totals into a team score would double-count any such
 * shared flag, so a synthesised row deliberately fabricates no SCORER points:
 * it starts at `points: 0`. Real (deduped) secure-development team points
 * require the scorer/lambda path, which computes them from per-flag data
 * upstream and sets `capabilities.teams = true` before this function ever runs.
 *
 * Module points ARE added to the rows synthesised here, via
 * `withTeamQuizPoints`, `withTeamClassicPoints` and `withTeamAiPoints` — the
 * quiz stores which QUESTION each member answered, classic which CHALLENGE
 * each member solved, and ai which CHALLENGE each member solved, so a team's
 * total can be deduped by item (an item three teammates hold counts once)
 * with no per-flag scorer data involved. Leaving them at zero meant a
 * quiz-only (or classic-only, or ai-only) event opened on its DEFAULT view —
 * the teams board, whenever teams exist — with every team tied at nothing
 * while the individual view showed real points. The attribution deliberately
 * lives in `module-contributions.ts` and is merely CALLED from here, so the
 * union rule has exactly one implementation; the pipeline order is unchanged.
 *
 * The three are applied in sequence, each adding only its own module's
 * points and re-ranking on the running total, and each no-ops when its
 * module is disabled — so a single-module event pays for exactly one of
 * them.
 *
 * Membership is matched case-insensitively, like every other login join in
 * this codebase: rows created from module points carry the module store's
 * spelling of the login, and a case disagreement with the team record would
 * otherwise silently drop the team chip.
 *
 * No-ops when the source already provides deduped teams (mock/lambda), when
 * team writes are disabled, or when no teams exist yet. Upstash trouble
 * degrades to the team-less view rather than failing the whole leaderboard.
 */
export async function withTeamStandings(data: LeaderboardData): Promise<LeaderboardData> {
  let teams;
  try {
    teams = await listTeams();
  } catch (err) {
    console.error("team standings unavailable:", err);
    return data;
  }
  if (teams.length === 0) return data;

  // A source that reports teams of its own (scorer/lambda) does NOT mean the
  // team store has nothing to add. Those are two different records: the source
  // knows the teams IT has scored, the team store knows the teams contestants
  // actually created — with a captain, a join code and a roster. This function
  // used to return early on `capabilities.teams`, so one team in the source was
  // enough to drop every app-side team from the board and leave every entry
  // team-less, including members of the source's own teams. A live event hit it
  // through the DEMO_MODE seeder: three seeded teams in the scorer permanently
  // hid the organizer's real team, silently, and a redeploy did not clear it
  // because seeds are data (issue #413).
  //
  // So the source's rows are KEPT rather than recomputed — that is the part
  // this function cannot do, per the note above: only the scorer has the
  // per-flag data to dedupe a secure-development flag two teammates both
  // solved, and re-synthesising those rows here would fabricate or double-count
  // points. App-side teams the source does not know are appended beside them,
  // starting at `points: 0` for exactly the same reason.
  const storeBySlug = new Map(teams.map((team) => [team.slug, team]));
  // A slug both records claim keeps the source's row — its points are the
  // deduped ones — but takes the UNION of the two rosters. The overlays fold
  // by `members` (`teams.map((team) => team.members)` in module-contributions),
  // so a member the source has not heard of would otherwise have their quiz,
  // classic and ai items left out of their own team's total: a roster short by
  // one name silently undercounts, which is worse than the missing row this
  // change set out to fix. Deduped case-insensitively, like every login join in
  // this codebase, keeping the team store's spelling; sorted, as listTeams
  // returns them.
  const sourceTeams = (data.capabilities.teams ? data.teams : []).map((team) => {
    const stored = storeBySlug.get(team.slug);
    if (!stored) return team;
    const byLower = new Map(team.members.map((member) => [member.toLowerCase(), member]));
    for (const member of stored.members) byLower.set(member.toLowerCase(), member);
    return { ...team, members: [...byLower.values()].sort() };
  });
  const sourceSlugs = new Set(sourceTeams.map((team) => team.slug));

  const teamByLogin = new Map<string, string>();
  for (const team of teams) {
    for (const member of team.members) teamByLogin.set(member.toLowerCase(), team.slug);
  }
  // Source rows carry their own roster, and a login the team store does not
  // place stays attributed to the source's team rather than losing its chip.
  for (const team of sourceTeams) {
    for (const member of team.members) {
      const login = member.toLowerCase();
      if (!teamByLogin.has(login)) teamByLogin.set(login, team.slug);
    }
  }

  const membershipOnly: TeamStanding[] = teams
    .filter((team) => !sourceSlugs.has(team.slug))
    .map((team) => ({
      slug: team.slug,
      name: team.name,
      // team-store's TeamInfo doesn't expose captain yet (listTeams only
      // reads name + members) — default to the first member rather than
      // changing team-store.ts for this.
      captain: team.members[0] ?? "",
      members: team.members,
      // No per-flag data here to dedupe shared flags with — see doc above.
      // Module points are added on top, by question, below.
      points: 0,
    }))
    // Alphabetical is the tie-break, not the order: the module overlays
    // re-rank on the attributed totals and keep this position for teams they
    // cannot separate (and for every team, when no module has points to add).
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((team, i) => ({ ...team, rank: i + 1 }));

  // The overlays run over the UNION, not just the rows synthesised here. They
  // attribute quiz, classic and ai points by ITEM — deduped across members with
  // no per-flag scorer data involved — so they are as correct for a source's
  // team as for an app-only one, and running them only on part of the board
  // would rank teams on different point sets. On a scorer-sourced board this
  // also fixes a matching gap: the team view listed secure-development points
  // alone while the individual view counted every module.
  const standings = await withTeamAiPoints(
    await withTeamClassicPoints(await withTeamQuizPoints([...sourceTeams, ...membershipOnly])),
  );

  return {
    ...data,
    entries: data.entries.map((entry) => {
      const slug = teamByLogin.get(entry.login.toLowerCase());
      return slug ? { ...entry, team: slug } : entry;
    }),
    teams: standings,
    capabilities: { ...data.capabilities, teams: true },
  };
}
