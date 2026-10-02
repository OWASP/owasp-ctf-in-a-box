import "server-only";

/**
 * The folded leaderboard's invalidation token (#553).
 *
 * The fold is memoized for ~10 s (`folded.ts`). That is fine while scores
 * only grow — a stale read undercounts, which every reader tolerates — but
 * two admin operations LOWER scores: Support's per-player reset
 * (`admin-ops-store.ts`) and the master reset (`admin-store.ts`). The hint
 * gate reads a contestant's gross from the memo, so without this a freshly
 * reset contestant could buy a hint against points that no longer exist.
 *
 * A leaf on purpose: `admin-store` sits UPSTREAM of the fold (the fold's
 * penalty stage reads the hint config, which reads admin settings), so it
 * cannot import `folded.ts` without a cycle. Both resets bump the generation
 * here; `folded.ts` stamps each fold with the generation it STARTED under
 * and serves nothing stamped older — a fold already running when the reset
 * came is discarded too, since it read the pre-reset keys.
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
