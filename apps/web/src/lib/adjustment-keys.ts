/** The score-adjustment ledger: adjustment id -> JSON row (adjustments-store.ts).
 *  Its own module so the master reset can name it without importing the store,
 *  which imports admin-store itself. */
export const ADJUSTMENTS_KEY = "ctf:adjustments";

/** Same ceiling as a hint price: an adjustment is a correction, not a score.
 *  Here, not in the store, so the admin form can check it too. */
export const ADJUSTMENT_MAX = 100_000;
