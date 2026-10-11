/** The score-adjustment ledger: adjustment id -> JSON row (adjustments-store.ts).
 *  Its own module so the master reset can name it without importing the store,
 *  which imports admin-store itself. */
export const ADJUSTMENTS_KEY = "ctf:adjustments";
