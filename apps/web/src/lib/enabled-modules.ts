import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import { getAdminSettings } from "@/lib/admin-store";
import { defaultEnabledModules, secureDevAvailable } from "@/lib/module-defaults";
import type { ModuleId } from "@/lib/modules";

/** The module set this deployment starts with, and falls back to: computed
 *  once from the server's env (issue #386). Secure Development when a scorer
 *  image exists, otherwise nothing — quiz and classic are switched on from
 *  /admin. Server-only on purpose: SCORE_IMAGE is not in the client bundle. */
export const defaultModuleIds: readonly ModuleId[] = defaultEnabledModules(process.env);

/** Same one-time read as `defaultModuleIds`, for the narrowing below — computed
 *  once at import time so it can never disagree with the default it derived. */
const secureDevOK = secureDevAvailable(process.env);

/** The settings read every other accessor in this module (and
 *  `resolved-modules.ts`'s `getResolvedModules`) builds on — ONE snapshot per
 *  request, fail-open to `null` (CodeRabbit round 1 finding A). Before this
 *  existed, `getEnabledModuleIds` and `getResolvedModules` each called
 *  `getAdminSettings()` on their own `cache()`-wrapped function, which
 *  deduped each one WITHIN itself but not against the other — two settings
 *  reads per request that could, on an unlucky Redis blip landing between
 *  them, disagree about the stored set. Funnelling both through this one
 *  `cache()`-wrapped read closes that: whichever of the two runs first pays
 *  for `getAdminSettings()`, and the other gets the exact same resolved (or
 *  exact same failed-to-null) value.
 *
 *  `await connection()` here (not repeated by callers) is the same
 *  build-time-prerender guard as everywhere else in this file — see
 *  `getEnabledModuleIds`'s comment for why it is load-bearing. */
export const getAdminSettingsSnapshot = cache(async () => {
  await connection();
  return getAdminSettings().catch(() => null);
});

/** Which modules this event is serving RIGHT NOW.
 *
 *  The stored set from `ctf:admin:settings` wins, including an explicitly
 *  empty one — an organizer who switched every board off meant it. Only when
 *  NOTHING is stored (`null`), or the read fails, does the default apply. The
 *  read fails **open** to that default: a Redis blip must render the modules
 *  this deployment was brought up for, never a surprise. Two load-bearing
 *  details, shared with `getResolvedModules`:
 *
 *  - `await connection()` (inside `getAdminSettingsSnapshot`) keeps the read
 *    out of the build-time prerender.
 *  - `cache()` dedupes WITHIN a request only; a toggle is live on the next.
 *
 *  Disabling a module writes nothing to its data — the toggle is a switch.
 *
 *  One narrowing happens after the stored-vs-default resolution either way:
 *  `secure-development` is dropped when this deployment has no scorer image.
 *  A stored set can carry it forward from before `SCORE_IMAGE` was unset —
 *  `updateAdminSettings` allows that (issue #386) so switching it back on
 *  needs no re-enable — but an unscoreable board is never SERVED. This
 *  narrowing is the reason `getResolvedModules` gets its live set from THIS
 *  function rather than reading `enabledModuleIds` off the settings snapshot
 *  directly: reading it raw would show secure-development's card on the
 *  landing page while `isModuleLive("secure-development")` answers false for
 *  the very same request (finding A's bug). */
export const getEnabledModuleIds = cache(async (): Promise<ReadonlySet<ModuleId>> => {
  const settings = await getAdminSettingsSnapshot();
  const resolved = new Set(settings?.enabledModuleIds ?? defaultModuleIds);
  if (!secureDevOK) resolved.delete("secure-development");
  return resolved;
});

export async function isModuleLive(id: ModuleId): Promise<boolean> {
  return (await getEnabledModuleIds()).has(id);
}
