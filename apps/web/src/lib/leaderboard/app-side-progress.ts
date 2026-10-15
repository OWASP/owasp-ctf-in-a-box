// The gate for a board row's per-item lists (BoardItemLists). Kept out of
// that component's file so its tests can mock the component and still run
// the real gate; pure and client-safe.

import type { ModuleProgress } from "./types";

/** Whether a board row has anything for its item lists to show: a completed item in
 *  any module but secure-development, which has its own target breakdown and
 *  never those lists. Derived from the row's blocks rather than hand-listing
 *  quiz/classic/ai — a hand-listed gate once dropped ai's lists when that
 *  module shipped. Keyed on `completed`, not on a block being present: every
 *  live module has a block from the start, at 0 / N, and a row
 *  with nothing done must not start a fetch on expand. */
export function hasAppSideProgress(modules: Partial<Record<string, ModuleProgress>> | undefined): boolean {
  return Object.entries(modules ?? {}).some(([id, m]) => id !== "secure-development" && (m?.completed ?? 0) > 0);
}
