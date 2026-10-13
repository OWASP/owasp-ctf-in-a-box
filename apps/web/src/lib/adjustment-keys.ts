/** The score-adjustment ledger: adjustment id -> JSON row (adjustments-store.ts).
 *  Its own module so the master reset can name it without importing the store,
 *  which imports admin-store itself. */
export const ADJUSTMENTS_KEY = "ctf:adjustments";

/** Same ceiling as a hint price: an adjustment is a correction, not a score.
 *  Here, not in the store, so the admin form can check it too. */
export const ADJUSTMENT_MAX = 100_000;

/** The team slug an adjustment names, after the trim and lowercase the store
 *  applies. Here so the admin form enables Add only for one it accepts. */
export function isTeamSlug(text: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(text.trim().toLowerCase());
}
