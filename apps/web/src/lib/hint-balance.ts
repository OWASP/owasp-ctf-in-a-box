import "server-only";
import { getFoldedLeaderboard } from "@/lib/leaderboard/folded";
import { HINTS_SPENT_KEY } from "@/lib/team-keys";
import { upstashPipeline } from "@/lib/upstash";

/**
 * What a contestant can spend on hints (#553): their folded, all-module score
 * net of hint spend. The affordability gate in `hint-store.ts`'s `hintGate`
 * refuses a reveal when `net < cost`, and the reveal reports `net - cost`
 * back as the resulting score.
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
 * SPENT is read fresh. The fold is memoized for ~10 s
 * (`LEADERBOARD_FOLD_TTL_MS`), so a hint bought a second ago is in
 * `ctf:hints:spent` but not yet in the row — two quick purchases must not
 * both pass on the same stale balance. The larger of the fresh read and the
 * row's penalty is used: the row's figure is the case-variant SUM
 * `withHintPenalties` computes, which a single HGET by the session's spelling
 * can undercount, and the fresh read is ahead of it right after a purchase.
 * They never disagree in the other direction.
 *
 * FAILS BY THROWING. A fold or spend read that errors rejects, and the gate
 * fails CLOSED on it (a hint is a paid reveal — see `hintGate`). A row that
 * is simply absent is not an error: that contestant has no points anywhere.
 */
export type HintBalance = { gross: number; spent: number; net: number };

export async function hintBalance(login: string): Promise<HintBalance> {
  const [board, [spentRes]] = await Promise.all([
    getFoldedLeaderboard(),
    upstashPipeline([["HGET", HINTS_SPENT_KEY, login]]),
  ]);
  // upstashPipeline reports a per-command error positionally rather than
  // throwing (AGENTS.md); an unchecked `.result` would read NOAUTH as 0 spent.
  if (spentRes.error !== undefined) throw new Error(`hint spend read failed: ${spentRes.error}`);
  // Logins join case-insensitively everywhere (AGENTS.md): the scorer keeps
  // the PR author's spelling, the session its own.
  const key = login.toLowerCase();
  const row = board.entries.find((e) => e.login.toLowerCase() === key);
  const penalty = row?.hintPenalty ?? 0;
  const gross = row ? row.points + penalty : 0;
  const spent = Math.max(penalty, Number(spentRes.result) || 0);
  return { gross, spent, net: gross - spent };
}
