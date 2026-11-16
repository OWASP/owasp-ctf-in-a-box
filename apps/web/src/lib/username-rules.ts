/**
 * The one rule set for a username: the better-auth username plugin validates
 * and stores with these, the sign-in throttle keys on `normalizeUsername`, and
 * the sign-up form checks with `usernameProblem` before it posts. No
 * `server-only`: the form imports it.
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const USERNAME_RE = /^[A-Za-z0-9_.]+$/;

/** The stored, unique form of a username, and the rate-limit key. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** What is wrong with a typed username, or null. Surrounding spaces do not count. */
export function usernameProblem(raw: string): "too_short" | "too_long" | "invalid" | null {
  const u = raw.trim();
  if (u.length < USERNAME_MIN) return "too_short";
  if (u.length > USERNAME_MAX) return "too_long";
  if (!USERNAME_RE.test(u)) return "invalid";
  return null;
}
