import "server-only";
import { errorLabel } from "@/lib/error-label";
import { upstashPipeline } from "@/lib/upstash";

/**
 * The folded leaderboard's invalidation token (#553), in two halves.
 *
 * 1. A PROCESS-local generation. The fold is memoized for ~10 s
 *    (`folded.ts`); that is fine while scores only grow — a stale read
 *    undercounts, which every reader tolerates — but the admin operations
 *    that LOWER a folded score must not leave the board on the instance that
 *    did the write serving the old one for a TTL. `folded.ts` stamps each
 *    fold with the generation it STARTED under and serves nothing stamped
 *    older — a fold already running when the invalidation came is discarded
 *    too, since it read the old keys.
 *
 * 2. A Redis-backed SCORE REVISION (`ctf:admin:score-rev`, under the admin
 *    prefix the master reset keeps) that every app task can see. The AWS
 *    module runs two app tasks, so a process-local signal never reaches the
 *    other one — and even a fresh fold on the right task can finish AFTER a
 *    write on the other task lowered the score. So the hint gate's gross
 *    travels with the revision it was folded under (`hint-balance.ts` reads
 *    it BEFORE folding), and the reveal script compares it to the current
 *    one before it reads the spend or charges: moved means stale, and the
 *    store re-reads and retries once (`REVEAL_SCRIPT`, ARGV[9]).
 *
 * Every operation that can lower a folded score calls
 * `invalidateFoldedLeaderboard()` TWICE: once BEFORE its first write and
 * once in a `finally` AFTER its last. Before, because the writes are not
 * atomic with the bump: a hint fold that read the old points under revision
 * R, and whose charge reaches the script while the (multi-step) wipe is
 * still running, must already find R moved. After, because a fold that
 * started mid-wipe read a mix and must be outdated too — and a failure
 * midway leaves the earlier destructive stages standing, so that bump has
 * to happen on the failure path as well. The callers: the master reset and
 * every settings write (`admin-store.ts` — the fold counts only the ENABLED
 * modules' points, so switching one off lowers scores), the demo clear
 * (`admin-store.ts`), Support's per-player reset and delete
 * (`admin-ops-store.ts`). An archive import goes through the master reset
 * first and then adds content only.
 *
 * A leaf on purpose: `admin-store` sits UPSTREAM of the fold (the fold's
 * penalty stage reads the hint config, which reads admin settings), so it
 * cannot import `folded.ts` without a cycle.
 */
export const SCORE_REV_KEY = "ctf:admin:score-rev";

let generation = 0;

/** Drop this instance's memo and bump the shared revision. The Redis bump
 *  failing is logged, not thrown: this instance's memo drops regardless, and
 *  the caller's own error (if any) is the one worth surfacing — but the other
 *  tasks lose the signal for this one write, which the log line records. */
export async function invalidateFoldedLeaderboard(): Promise<void> {
  generation++;
  try {
    const [res] = await upstashPipeline([["INCR", SCORE_REV_KEY]]);
    if (res.error !== undefined) throw new Error(res.error);
  } catch (err) {
    console.error(
      "fold-cache: score revision bump failed (other app tasks will not see this write):",
      errorLabel(err),
    );
  }
}

/** The current generation, for `folded.ts` to stamp and compare. */
export function foldGeneration(): number {
  return generation;
}

/** The shared revision as the script will compare it: the stored string,
 *  "0" when nothing has ever bumped it. Throws on a read error — a gross
 *  nobody can vouch for is refused by the gate (closed), not guessed. */
export async function currentScoreRevision(): Promise<string> {
  const [res] = await upstashPipeline([["GET", SCORE_REV_KEY]]);
  if (res.error !== undefined) throw new Error(`score revision read failed: ${res.error}`);
  return res.result == null ? "0" : String(res.result);
}
