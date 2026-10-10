import "server-only";
import { errorLabel } from "@/lib/error-label";
import { listTeams } from "@/lib/team-store";
import {
  mergeTeamRosters,
  withTeamAiPoints,
  withTeamClassicPoints,
  withTeamQuizPoints,
} from "./module-contributions";
import { rankByStanding } from "./rank";
import type { LeaderboardData, LeaderboardEntry, TeamStanding } from "./types";

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
 * Module points ARE added — to the rows synthesised here AND to the source's
 * own teams, in this one place and nowhere else (issue #520) — via
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
 * When the team store holds no teams, or cannot be read, membership is left
 * as the source reported it — a team-less view on a source with no teams of
 * its own, rather than failing the whole leaderboard. The source's own teams
 * (scorer/lambda) still get their module points in that case: this is the one
 * place those are added, so skipping it would drop them, not just the
 * app-side rows.
 */
export async function withTeamStandings(data: LeaderboardData): Promise<LeaderboardData> {
  let teams;
  try {
    teams = await listTeams();
  } catch (err) {
    console.error("team standings unavailable:", errorLabel(err));
    return withSourceTeamModules(data);
  }
  if (teams.length === 0) return withSourceTeamModules(data);

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
  //
  // The roster UNION and the login index come from `mergeTeamRosters`, shared
  // with the contestant path in module-contributions.ts: the overlays fold by
  // `members`, so a roster short by one name silently undercounts its own
  // team's items — and a player's story-lock reachability folding over a
  // different membership than the team row's would unlock a different set of
  // steps for the same contest.
  const { sourceTeams, teamByLogin } = mergeTeamRosters(data, teams);
  const sourceSlugs = new Set(sourceTeams.map((team) => team.slug));

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
  //
  // This is the ONLY place the app-side modules reach a team's points.
  // `withModuleContributions` stamps a source team's secure-development chip
  // and nothing else; it used to add quiz, classic and ai too, and with this
  // call on top every scorer team counted them twice (issue #520).
  const standings = await withAppModulePoints([...sourceTeams, ...membershipOnly]);

  const entries = data.entries.map((entry) => {
    const slug = teamByLogin.get(entry.login.toLowerCase());
    return slug ? { ...entry, team: slug } : entry;
  });
  // Every team member gets an Individual row, a 0 one if they have not
  // scored: the Teams view lists every team, so a player who could find their
  // team there could not find themselves here. Every roster counts, the team
  // store's first (its spelling and placement win) and then the source's;
  // logins match case-insensitively against the rows that exist. Signing in
  // without a team creates no row. Named in order so the ties at 0 read
  // alphabetically after everyone who scored.
  const listed = new Set(entries.map((entry) => entry.login.toLowerCase()));
  const unlisted: { login: string; slug: string }[] = [];
  for (const team of [...teams, ...sourceTeams]) {
    for (const login of team.members) {
      if (listed.has(login.toLowerCase())) continue;
      listed.add(login.toLowerCase());
      unlisted.push({ login, slug: team.slug });
    }
  }
  const zeroRows: LeaderboardEntry[] = unlisted
    .sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()))
    .map(({ login, slug }) => ({
      rank: 0,
      login,
      team: slug,
      points: 0,
      patched: 0,
      failed: 0,
      total: 0,
      apps: {},
      updatedAt: null,
      lastSolveAt: null,
      modules: {},
    }));

  return {
    ...data,
    entries: zeroRows.length ? rankByStanding([...entries, ...zeroRows]) : entries,
    teams: standings,
    capabilities: { ...data.capabilities, teams: true },
  };
}

/** The three app-side module overlays, applied in sequence (each adds only its
 *  own module and re-ranks on the running total; each no-ops when its module
 *  is off). The one call site for all of them — see the #520 note above. */
async function withAppModulePoints(teams: TeamStanding[]): Promise<TeamStanding[]> {
  return withTeamAiPoints(await withTeamClassicPoints(await withTeamQuizPoints(teams)));
}

/** The no-team-store path: the source's own teams, if it has any, still get
 *  their module points; a source with none passes through untouched. */
async function withSourceTeamModules(data: LeaderboardData): Promise<LeaderboardData> {
  if (!data.capabilities.teams || data.teams.length === 0) return data;
  return { ...data, teams: await withAppModulePoints(data.teams) };
}
