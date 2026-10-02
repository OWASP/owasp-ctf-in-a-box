import "server-only";

/**
 * The folded leaderboard's invalidation token (#553).
 *
 * The fold is memoized for ~10 s (`folded.ts`). That is fine while scores
 * only grow — a stale read undercounts, which every reader tolerates — but
 * the admin operations that LOWER a folded score must not leave the board
 * serving the old one for a TTL on the instance that did the write. Every
 * such operation calls `invalidateFoldedLeaderboard()` after its LAST write
 * (an earlier call can be refilled by a fold racing the writes): the master
 * reset and every settings write (`admin-store.ts` — the fold counts only
 * the ENABLED modules' points, so switching one off lowers scores), the demo
 * clear (`admin-store.ts`), Support's per-player reset and delete
 * (`admin-ops-store.ts`). An archive import goes through the master reset
 * first and then adds content only.
 *
 * This is PROCESS-local, and the AWS module runs two app tasks — a write on
 * one never reaches the other's memo. So the hint affordability gate does
 * NOT rely on it: `hint-balance.ts` folds fresh (`fresh: true`) every time.
 * The invalidation is for the board; the gate pays for its own read.
 *
 * A leaf on purpose: `admin-store` sits UPSTREAM of the fold (the fold's
 * penalty stage reads the hint config, which reads admin settings), so it
 * cannot import `folded.ts` without a cycle. Callers bump the generation
 * here; `folded.ts` stamps each fold with the generation it STARTED under
 * and serves nothing stamped older — a fold already running when the
 * invalidation came is discarded too, since it read the old keys.
 */
let generation = 0;

/** Drop the memo: the next read folds fresh. Call AFTER the last write of a
 *  score-lowering operation, or a fold racing it refills the memo with the
 *  old points. */
export function invalidateFoldedLeaderboard(): void {
  generation++;
}

/** The current generation, for `folded.ts` to stamp and compare. */
export function foldGeneration(): number {
  return generation;
}
