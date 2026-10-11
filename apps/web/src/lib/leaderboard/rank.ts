import type { LeaderboardEntry, TeamStanding } from "./types";

/** Standing order, most significant first (#522):
 *
 *    1. total points descending — the same rule the team view and the
 *       scorer's own board use, so the two views of one board agree;
 *    2. items completed ACROSS MODULES descending — a tiebreak only: at equal
 *       points, more items ranks higher. With only secure-development enabled
 *       this is exactly the old `patched` count;
 *    3. earliest activity ascending — whoever reached that score first ranks
 *       higher.
 *
 *  Entries without a parseable activity time sort after those with one, so
 *  remaining ties fall through to the caller's stable ordering. */
export function compareStanding(a: LeaderboardEntry, b: LeaderboardEntry): number {
  return b.points - a.points || completedCount(b) - completedCount(a) || activityMs(a) - activityMs(b);
}

/** Completion across modules — the board's points tiebreak, and the number
 *  its solved column SHOWS. Exported for the row's own solved
 *  column: computing it a second time in the component is how a displayed
 *  figure drifts from the ordering it is supposed to explain.
 *
 *  Falling back to `patched` for sources that carry
 *  no secure-development module data (upstash: `capabilities.apps: false`, so
 *  `withModuleContributions` never stamps a `secure-development` block).
 *
 *  That fallback only matters within a points tie: it breaks a tie on the
 *  upstash board the same way it breaks one on the lambda and mock sources,
 *  rather than leaving upstash the one board where equal points fall back to
 *  the raw `ZRANGE` order.
 *
 *  The fallback is keyed on the `secure-development` block specifically, NOT
 *  on `modules` being empty — an upstash row with quiz activity gets a `quiz`
 *  block stamped (making `modules` non-empty) while `patched` still holds
 *  real, un-represented completions. Falling back only when `modules` is
 *  empty would drop `patched` entirely the moment ANY module (e.g. quiz)
 *  populated the map — demoting a contestant for answering a quiz question,
 *  which is the opposite of what adding quiz points is supposed to do.
 *
 *  That mutation is caught in
 *  `__tests__/module-contributions.test.ts` ("keeps a quiz-active row's
 *  patches in the tiebreak on an upstash-shaped board"), NOT in
 *  `__tests__/rank.test.ts`, which has no upstash-shaped case: this
 *  comparator only sees the rows `withModuleContributions` has already
 *  stamped, so the upstash shape can only be built through that function.
 *  Follow the pointer before changing the fallback. */
export function completedCount(entry: LeaderboardEntry): number {
  const mods = Object.values(entry.modules ?? {});
  const base = entry.modules?.["secure-development"] ? 0 : entry.patched;
  return base + mods.reduce((n, m) => n + (m?.completed ?? 0), 0);
}

/** An entry's most recent scoring activity: the newest per-module timestamp
 *  (an entry's own "last touched" moment), falling back to `lastSolveAt`.
 *  DO NOT change `Math.max` to `Math.min` — the comparator sorts these
 *  values ASCENDING across entries, so the entry whose most recent activity
 *  is earliest (i.e. stopped changing soonest) wins the tie, which is what
 *  makes "reached that score first ranks higher" hold. Entries with no
 *  parseable timestamp anywhere get `Number.MAX_SAFE_INTEGER` so they still
 *  sort last. */
function activityMs(entry: LeaderboardEntry): number {
  const stamps = Object.values(entry.modules ?? {})
    .map((m) => m?.lastActivityAt)
    .concat(entry.lastSolveAt ?? null)
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms)) as number[];
  return stamps.length > 0 ? Math.max(...stamps) : Number.MAX_SAFE_INTEGER;
}

/** Sorts by standing (source order breaks any remaining ties) and re-stamps
 *  rank 1..n. */
export function rankByStanding(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => compareStanding(a.entry, b.entry) || a.i - b.i)
    .map(({ entry }, i) => ({ ...entry, rank: i + 1 }));
}

/** The team view's standing order, the same three keys as `compareStanding`:
 *
 *    1. total points descending;
 *    2. items completed across modules descending;
 *    3. whoever earned their LAST points first: the latest activity time over
 *       every module's block and the scorer's Secure Development finish.
 *
 *  (3) has to read every module: the scorer's own order knows only Secure
 *  Development, so three teams tied on points and items would otherwise be
 *  ranked by who finished SD first, not by who finished. Hint purchases move
 *  points, never this time. Teams without a
 *  parseable time sort after those with one; the caller keeps remaining ties
 *  stable. */
export function compareTeamStanding(a: TeamStanding, b: TeamStanding): number {
  return b.points - a.points || teamCompleted(b) - teamCompleted(a) || teamActivityMs(a) - teamActivityMs(b);
}

/** Completion across modules, as `completedCount` reads it for a contestant:
 *  the module blocks, plus the scorer's SD count when no secure-development
 *  block was stamped (a scorer without a catalogue gives none), so SD solves
 *  count exactly once either way. */
function teamCompleted(team: TeamStanding): number {
  const modules = team.modules ?? {};
  const blocks = Object.values(modules).reduce((sum, m) => sum + (m?.completed ?? 0), 0);
  return modules["secure-development"] ? blocks : blocks + (team.patched ?? 0);
}

function teamActivityMs(team: TeamStanding): number {
  const stamps = Object.values(team.modules ?? {})
    .map((m) => m?.lastActivityAt)
    .concat(team.lastSolveAt ?? null)
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms)) as number[];
  return stamps.length > 0 ? Math.max(...stamps) : Number.MAX_SAFE_INTEGER;
}
