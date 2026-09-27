// Explicit same-origin assertion for the app's own mutating API routes.
//
// WHAT THIS ADDS. Every custom route authenticates from the session cookie,
// and that cookie is `SameSite=Lax`, which already blocks the cross-site POST
// a CSRF attack needs. So this is defence in depth, not a fix for a live hole:
// today's protection is a better-auth default, held one dependency bump or one
// config edit away from changing under us. An explicit check keeps the
// property true for reasons this repo controls.
//
// Deliberately dependency-free — no `server-only`, no `next/*` — because
// `proxy.ts` imports it and that module's graph is kept to primitives that are
// safe outside a request scope.

/** Methods that can change state, and therefore the ones worth asserting on.
 *  A cross-origin GET is not a CSRF concern here: no route mutates on GET. */
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether a request may proceed, given its `Origin` header and the event's
 * configured URL.
 *
 * Two allow-cases are deliberate, and both are the standard reading rather
 * than a shortcut:
 *
 *   - **No `Origin` header** → allow. Browsers attach `Origin` to every
 *     cross-origin request that carries credentials, so its absence means a
 *     non-browser client (curl, a script, a health check) — which has no
 *     ambient cookie to ride in the first place, and so cannot mount the
 *     attack this defends against. Rejecting on absence would break ordinary
 *     tooling while adding no protection.
 *   - **No configured URL** → allow. With `BETTER_AUTH_URL` unset there is
 *     nothing to compare against; inventing an expectation from the request's
 *     own `Host` header would let an attacker satisfy the check by setting it.
 *     A gap that is honest beats one that looks like enforcement.
 *
 * Comparison is origin-to-origin (scheme + host + port), parsed rather than
 * string-compared, so a trailing slash or a path on the configured URL cannot
 * make a legitimate request fail.
 */
export function originAllowed(opts: { origin: string | null | undefined; configuredUrl: string | undefined }): boolean {
  const { origin, configuredUrl } = opts;
  if (!origin) return true;
  if (!configuredUrl) return true;

  let expected: string;
  try {
    expected = new URL(configuredUrl).origin;
  } catch {
    // A malformed BETTER_AUTH_URL is a config error, not an attack signal.
    // Failing shut here would take the whole API down for a typo.
    return true;
  }

  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    // A present-but-unparseable Origin is not something a browser sends.
    return false;
  }

  return actual === expected;
}
