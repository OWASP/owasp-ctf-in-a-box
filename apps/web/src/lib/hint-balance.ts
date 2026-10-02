import "server-only";
import { currentScoreRevision } from "@/lib/leaderboard/fold-cache";
import { getFoldedLeaderboard } from "@/lib/leaderboard/folded";
import { HINTS_SPENT_KEY } from "@/lib/team-keys";
import { upstashPipeline } from "@/lib/upstash";

/**
 * What a contestant can spend on hints (#553): their folded, all-module score
 * net of hint spend. The affordability gate in `hint-store.ts`'s `hintGate`
 * refuses a reveal when `net < cost`. The resulting score the reveal reports
 * is NOT `net - cost` from these figures: it is `gross` minus the spend total
 * the reveal script saw after the charge (post-call, case-folded), because a
 * parallel reveal can land between this read and the script. `gross` is the
 * only figure of these three that outlives the call.
 *
 * WHY ITS OWN MODULE. The folded leaderboard (`leaderboard/folded.ts`) ends
 * in `withHintPenalties`, which imports the hint config — so `hint-store.ts`
 * importing the fold directly would be a cycle. This leaf imports the fold,
 * the store imports this; `hint-config.ts` is the other half of that split.
 *
 * GROSS comes from the folded row. The board is the ONE place every module's
 * points are already summed per login (scorer, quiz, classic, ai — issue
 * #520's fold order), so this cannot disagree with what the contestant sees.
 * The row's `points` is NET and floored at 0, with the penalty beside it as
 * `hintPenalty`, so `points + hintPenalty` recovers gross exactly whenever
 * the row is not floored — and when it IS floored (true gross below the
 * penalty) it is an upper bound, which still yields net ≤ 0: a broke row is
 * reported broke, never as owed its penalty back.
 *
 * SPENT is read fresh, as the CASE-FOLDED SUM of the whole spend hash — one
 * HGETALL, the same read `getHintPenalties` makes per fold — never a single
 * HGET by the session's spelling. One person's purchases can sit under two
 * spellings of their login (a case-only GitHub rename mid-event), and the
 * single-field read undercounts exactly when it matters: a new purchase
 * under the current spelling could pass on that undercount even though the
 * row's summed penalty was already larger. Fresh is authoritative in BOTH
 * directions: ahead of the row's penalty right after a purchase (the fold
 * is memoized ~10 s, `LEADERBOARD_FOLD_TTL_MS`), and below it right after
 * Support's per-player reset deletes the spend. Two PARALLEL purchases are
 * the reveal script's problem: it re-reads the spend inside the charge, see
 * `REVEAL_SCRIPT`'s ARGV[8].
 *
 * GROSS IS FOLDED FRESH, never from the memo (`fresh: true`). The memo and
 * its invalidation (`leaderboard/fold-cache.ts`, bumped by every admin op
 * that lowers a score) are PROCESS-local, and the AWS module runs two app
 * tasks: a settings write or reset on one task never reaches the other's
 * memo, which could then serve a pre-write gross for up to the TTL. The gate
 * reaches this read only after the module, enabled, time and progress gates
 * (a burner with no solves never folds), and the reveal route is
 * rate-limited per login, so paying the fold every time is affordable.
 *
 * THE REVISION TRAVELS WITH THE GROSS. Even a fresh fold can finish after a
 * write on the other task lowered the score. So the shared score revision
 * (`fold-cache.ts`, bumped by every score-lowering write) is read BEFORE the
 * fold and returned as `rev`; the reveal script compares it to the current
 * one before charging and refuses `stale` when it moved. Before, not after:
 * read after the fold, it would vouch for a gross that predates the write.
 *
 * FAILS BY THROWING. A fold, spend or revision read that errors rejects, and
 * the gate fails CLOSED on it (a hint is a paid reveal — see `hintGate`). A
 * row that is simply absent is not an error: no points anywhere.
 */
export type HintBalance = { gross: number; spent: number; net: number; rev: string };

export async function hintBalance(login: string): Promise<HintBalance> {
  const rev = await currentScoreRevision();
  const [board, [spentRes]] = await Promise.all([
    getFoldedLeaderboard({ fresh: true }),
    upstashPipeline([["HGETALL", HINTS_SPENT_KEY]]),
  ]);
  // upstashPipeline reports a per-command error positionally rather than
  // throwing (AGENTS.md); an unchecked `.result` would read NOAUTH as 0 spent.
  if (spentRes.error !== undefined) throw new Error(`hint spend read failed: ${spentRes.error}`);
  // Logins join case-insensitively everywhere (AGENTS.md): the scorer keeps
  // the PR author's spelling, the session its own, the spend hash whatever
  // the session had at each purchase.
  const key = login.toLowerCase();
  const row = board.entries.find((e) => e.login.toLowerCase() === key);
  const gross = row ? row.points + (row.hintPenalty ?? 0) : 0;
  const flat = Array.isArray(spentRes.result) ? (spentRes.result as string[]) : [];
  let spent = 0;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i].toLowerCase() === key) spent += Number(flat[i + 1]) || 0;
  }
  return { gross, spent, net: gross - spent, rev };
}
