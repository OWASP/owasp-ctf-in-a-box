import "server-only";
import { getLeaderboardSource } from "./source";
import { withModuleContributions } from "./module-contributions";
import { withTeamStandings } from "./team-standings";
import { withModuleSeries } from "./module-series";
import { withHintPenalties } from "./hint-penalties";
import { withScoreAdjustments } from "./score-adjustments";
import { foldGeneration } from "./fold-cache";
import type { LeaderboardData } from "./types";

/**
 * The folded leaderboard, memoized across requests (issue #444).
 *
 * WHY. The fold — source → module contributions → team standings → module
 * series → hint penalties — costs roughly 500 Redis commands and a scorer
 * round-trip at 200 contestants (`readModuleEvents` alone is one HGETALL per
 * login per live module), then the page renders 200 rows. It used to run on
 * EVERY page view, per viewer, although its result is identical for every
 * viewer: the only per-session input is the "you" highlight, which the client
 * applies from `viewerLogin`. The load test (#439) measured 2.7 req/s served
 * against 10 demanded after the payload fix (#443), with ~370 ms of CPU per
 * request. Six folds a minute instead of six hundred is the difference.
 *
 * TTL. Ten seconds, under the display board's own 30 s refresh. The scorer
 * fetch bypasses Next.js's fetch cache, so this memo is the only application-level
 * cache in front of the scorer read.
 *
 * FAIL OPEN, NEVER CACHE A FAILURE. A fold that throws is not stored: the
 * caller sees the error exactly as before, and the next request retries. A
 * Redis blip costs one slow page, never ten seconds of a frozen board.
 * Concurrent callers during a fold share the in-flight promise (the #440
 * lesson) — a room landing in the same second is one fold, not N.
 *
 * THE TTL STARTS WHEN THE FOLD FINISHES, not when it was asked for. A fold
 * that takes longer than the TTL (a slow scorer, a Redis stall) would
 * otherwise be stored already expired, and the next request would start
 * another one at once — the memo would turn into a queue of back-to-back
 * folds exactly when the box is slowest. The clock is read again on success.
 *
 * `now` (a clock) and `fold` are parameters for the tests; production calls
 * pass none.
 */

export const LEADERBOARD_FOLD_TTL_MS = 10_000;

type Fold = (options?: { fresh?: boolean }) => Promise<LeaderboardData>;
type Clock = () => number;

// Stage order is load-bearing (this commentary moved here from the page with
// the fold itself). withModuleContributions attributes (and, for the app-side
// modules, adds) each contestant row's gross per-module points, and
// withTeamStandings folds rows into teams — it is the ONE stage that adds
// quiz, classic and ai points to a team; the first stage only stamps a source
// team's secure-development block (running both on the source's teams counted
// those modules twice, issue #520). withHintPenalties then nets the final
// all-module total exactly once, and withScoreAdjustments applies the
// organizer's team adjustments. Module blocks everywhere show their gross
// contribution; the row's "−N hints" marker is what reconciles them against
// the netted header. Running the penalty fold before the module folds netted
// scorer points alone, which made hints free for any row whose points arrive
// later — a classic- or quiz-only contestant, or a team whose module points
// team standings folds in. Same story in docs/architecture.md, step 9 of the
// score data flow.
//
// withModuleSeries runs after both ranking overlays because it charts only
// the final top-ten entries and teams. A hint penalty or an organizer score
// adjustment can move a row across that boundary, so selecting the ranked set
// earlier would chart a line for a row that is no longer shown, or omit one
// that is. It reads the app-side modules' per-item timestamps to put their
// points on the chart at all (issue #415). It leaves `points` untouched: the
// chart is gross, the row net.
/** The production fold: the leaderboard source through every overlay stage.
 *  Times itself and logs once per FOLD (not per request — the 10 s memo
 *  absorbs the rest, issue #444), so an operator can separate fold cost from
 *  request/render latency on a live box: the load test's autocannon
 *  percentiles are whole-request numbers, and this line is the fold's share
 *  of them (issue #446). */
const defaultFold: Fold = async () => {
  const started = Date.now();
  const data = await (await getLeaderboardSource())
    .getLeaderboard()
    .then(withModuleContributions)
    .then(withTeamStandings)
    .then(withHintPenalties)
    // The organizer's team adjustments, after the hint fold: both come off
    // (or onto) the same final total. See score-adjustments.ts.
    .then(withScoreAdjustments)
    // Chart only the final ranked rows; both overlays above can move a row
    // across the top-ten boundary.
    .then(withModuleSeries);
  console.info(
    `leaderboard fold: ${Date.now() - started}ms ` +
      `(entries=${data.entries.length} teams=${data.teams.length} ` +
      `series=${data.series?.length ?? 0} teamSeries=${data.teamSeries?.length ?? 0})`,
  );
  return data;
};

// `gen` is the fold-cache generation the fold STARTED under (#553): the two
// admin resets that lower scores bump it, and nothing stamped older is served
// — not a memo, and not a fold still in flight when the reset came.
let cached: { at: number; data: LeaderboardData; gen: number } | null = null;
let inflight: Promise<LeaderboardData> | null = null;
let inflightGen = -1;

/** Test seam: the memo is module state by design, so tests reset it. */
export function resetFoldedLeaderboardCache(): void {
  cached = null;
  inflight = null;
}

/**
 * The folded board, shared by every request that asks within
 * `LEADERBOARD_FOLD_TTL_MS` of the last fold finishing. Concurrent callers
 * during a fold share it; a rejected fold is not cached and rejects every
 * caller sharing it, so the next request retries.
 *
 * Callers must treat the result as read-only — it is the same object handed
 * to every concurrent request.
 *
 * `fresh: true` folds now and bypasses the memo entirely: not served from
 * it, not stored into it, not shared with a fold in flight. The memo and its
 * invalidation are PROCESS-local, and the AWS module runs two app tasks, so a
 * score-lowering write on one task never reaches the other's memo — the hint
 * affordability gate (`hint-balance.ts`) is the one reader that must not pay
 * that staleness, and it is rare and rate-limited enough to fold every time.
 */
export async function getFoldedLeaderboard({
  now = Date.now,
  fold = defaultFold,
  fresh = false,
}: { now?: Clock; fold?: Fold; fresh?: boolean } = {}): Promise<LeaderboardData> {
  if (fresh) return fold({ fresh: true });
  const gen = foldGeneration();
  if (cached && cached.gen === gen && now() - cached.at < LEADERBOARD_FOLD_TTL_MS) return cached.data;
  if (inflight && inflightGen === gen) return inflight;
  inflightGen = gen;
  const run: Promise<LeaderboardData> = fold()
    .then((data) => {
      // Stamped on completion, not on request — see the header. Memoized only
      // if no invalidation came while it ran: a fold that started before a
      // reset read the pre-reset keys, and its caller gets it, but nobody else.
      if (gen === foldGeneration()) cached = { at: now(), data, gen };
      return data;
    })
    .finally(() => {
      // A superseded (stale) fold finishing must not clear the newer one.
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}
