import { upstashPipeline } from "@/lib/upstash";
import { LOGIN_RE } from "@/lib/admin-logins";

// Re-exported so the routes/stores that already import `LOGIN_RE` from here
// (the write path's natural home) do not need to also know about
// `admin-logins.ts`.
export { LOGIN_RE };

/**
 * The READ half of runtime admin grants (issue #147), deliberately in its own
 * module.
 *
 * `admin-auth.ts` is on the authorization path for every gated route and Server
 * Component, so what it imports matters. Putting this in `admin-store.ts` made
 * it pull in the whole admin surface — and through it `modules.ts` and the
 * module registry — for a one-line SMEMBERS. That showed up first as a test
 * blowing up on an unrelated mock, which was the cheap warning; the expensive
 * version is an import cycle discovered later.
 *
 * The WRITE half stays in `admin-store.ts`, where the audit log and
 * `AdminValidationError` already live.
 */

/** Logins granted admin at RUNTIME, on top of the ones in `ADMIN_LOGINS`. A
 *  Redis set, not a settings field: it is a collection with add/remove
 *  semantics, and membership is the whole value. */
export const ADMIN_ADMINS_KEY = "ctf:admin:admins";

/** Stored admins, lowercased. THROWS if Redis is unreachable — callers on the
 *  authorization path must let that propagate so the failure denies rather
 *  than resolving to an empty list, which would read as "not an admin" but
 *  for the wrong reason. `requireAdmin` catches it explicitly. */
export async function listStoredAdmins(): Promise<string[]> {
  const [res] = await upstashPipeline([["SMEMBERS", ADMIN_ADMINS_KEY]]);
  // An error REPLY throws too (#499) — read as an empty roster it would deny
  // for the wrong reason, which the doc comment above promises it does not.
  if (res.error) throw new Error(`Upstash SMEMBERS admins failed: ${res.error}`);
  const arr = Array.isArray(res.result) ? (res.result as string[]) : [];
  return arr.map((a) => String(a).toLowerCase()).sort();
}
