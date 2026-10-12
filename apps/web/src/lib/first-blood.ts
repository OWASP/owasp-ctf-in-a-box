// First blood (#188): the first contestant to solve a challenge. Display only:
// it moves no points. It is DERIVED from the solve rows on every read
// (team-solve-counts.ts's `teamSolveBoard`), never stored, so there is no
// marker to drift from the rows, and anything that removes a row (a progress
// reset, a deleted contestant) removes the first blood with it.
//
// Dependency-free on purpose, like the leaderboard's rank.ts: the order is a
// pure function a test can pin without a store.

/** The first solver of one challenge: the login as the team's member set
 *  spells it, and the solve row's `at` (null when the row has none). */
export type FirstBlood = { login: string; at: string | null };

/** The leaderboard's "whoever got there first" reasoning (rank.ts, the
 *  activity tiebreak), applied to one challenge's solves:
 *
 *    1. earliest solve time first, compared as instants, not strings;
 *    2. a row with no parseable time sorts after every row with one;
 *    3. an exact tie goes to the login that sorts first case-insensitively,
 *       then by exact spelling.
 *
 *  (3) is where this has to go further than the leaderboard, whose last
 *  resort is source order: here the source order is the team SCAN's, which
 *  differs between reads, and a first blood that changed hands on a page
 *  refresh would be worse than none. Plain code-unit comparison, not
 *  `localeCompare`, so the server's locale cannot move it either. */
export function compareFirstBlood(a: FirstBlood, b: FirstBlood): number {
  return atMs(a.at) - atMs(b.at) || codeUnitOrder(a.login.toLowerCase(), b.login.toLowerCase()) || codeUnitOrder(a.login, b.login);
}

/** Reducer form: the earlier of the two by `compareFirstBlood`. */
export function earlierFirstBlood(current: FirstBlood | undefined, next: FirstBlood): FirstBlood {
  return current === undefined || compareFirstBlood(next, current) < 0 ? next : current;
}

function atMs(at: string | null): number {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function codeUnitOrder(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
