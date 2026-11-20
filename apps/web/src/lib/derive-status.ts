import "server-only";
import type { ClassicStatus } from "@/components/challenge-detail";
import type { ViewerClassic } from "@/lib/classic-store";

/** Derives this viewer's status for one challenge from the SAME solved/
 *  cooldown rule the module's store enforces authoritatively at submit time
 *  (`evaluateGate` in classic-store.ts) — reimplemented
 *  here purely for display, using data the pages already have (one
 *  `getViewerClassic` pipeline + the current admin settings)
 *  instead of an extra round trip per challenge. A stale or drifted read here
 *  is a display nit at worst: the award Lua script re-checks both, atomically,
 *  against fresh state, and is the only thing that actually enforces the
 *  solved guard or the cooldown.
 *
 *  Shared by the board and the challenge page alike (/flags + /flags/[id]),
 *  so the tile a contestant clicked and the page it opens can never disagree
 *  about the same challenge's state.
 *
 *  `ClassicStatus` is an alias of `ChallengeStatus` in challenge-detail.tsx.
 *
 *  `now` defaults to `Date.now()` (read here, in a plain helper, rather than
 *  in a page component's own body) so the Server Components stay pure
 *  functions of their props for React's rules. */
export function deriveStatus(
  solve: ViewerClassic["solved"][string] | undefined,
  attempt: ViewerClassic["attempts"][string] | undefined,
  cooldownMs: number,
  now: number = Date.now(),
): ClassicStatus {
  if (solve) return { status: "solved", earnedPoints: solve.points };

  if (cooldownMs > 0 && attempt) {
    const lastMs = Date.parse(attempt.lastAt);
    if (Number.isFinite(lastMs)) {
      const retryAtMs = lastMs + cooldownMs;
      if (now < retryAtMs) return { status: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
    }
  }

  return { status: "unsolved" };
}
