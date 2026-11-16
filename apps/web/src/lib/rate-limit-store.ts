import "server-only";
import { errorLabel } from "@/lib/error-label";
import { upstashEval } from "@/lib/upstash";

/**
 * Per-login fixed-window rate limiter for authenticated routes.
 *
 * The per-player buckets are KEYED ON THE LOGIN, not the IP, and that is the
 * point. A leftmost `x-forwarded-for` entry is spoofable here, because the
 * proxy appends to the header rather than replacing it. These routes run
 * *after* `auth.api.getSession()`, so there is a session-backed login to key
 * on that a caller cannot forge without forging the session itself.
 *
 * The auth buckets (`signUpIp`, `signInIp`, `signInUser`) run before any
 * session exists and key on the client address instead, taken from the
 * RIGHTMOST `x-forwarded-for` entry, the one the single trusted proxy
 * appended (see `client-ip.ts`). Those counters are not a player's state, so
 * `rateLimitKeysFor` does not list them.
 *
 * Fixed window, not a sliding one: the thing being bounded is a burst (scripted
 * join-code guessing, a hammering client), and a fixed window costs one Lua
 * EVAL and one key. The known edge — up to 2× the limit across a window
 * boundary — is irrelevant at these budgets.
 *
 * FAILS OPEN. A Redis error lets the request through and logs. This is the
 * opposite of `consumeGateAttempt`, deliberately: that one guards a password
 * compare, where letting an unmetered guess through defeats the control.
 * These bound abuse of routes that have their own correctness gates
 * underneath (`joinTeam` validates the code; `revealHint` charges atomically
 * and is idempotent), so a Redis blip must not stop contestants playing. Same
 * fail-open reasoning the freeze reads use — see AGENTS.md. The one exception
 * is opt-in per call (`failClosed`): the admin claim, where the budget is the
 * guess bound itself.
 */

type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const rateKey = (bucket: string, login: string) => `ctf:rl:${bucket}:${login.toLowerCase()}`;

// KEYS[1] = ctf:rl:<bucket>:<login>
// ARGV[1] = limit   ARGV[2] = window seconds
//
// INCR-then-EXPIRE inside one script: the window starts at the first request
// and the key disappears on its own, so there is no timestamp bookkeeping and
// no cleanup. EXPIRE is set only when the counter is fresh (INCR returned 1),
// or every request would push the window's end further out and a steady
// stream of calls would never reset.
//
// TTL is read back rather than assumed: a key can already be mid-window, and
// the caller needs the real remaining time for Retry-After.
const CONSUME_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if n > tonumber(ARGV[1]) then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = tonumber(ARGV[2]) end
  return {0, ttl}
end
return {1, 0}`;

/** What a fail-closed budget answers when it cannot read its counter. */
const FAIL_CLOSED_RETRY_SECONDS = 60;

/**
 * Charge one request against `login`'s budget for `bucket`.
 *
 * @param limit   requests allowed per window
 * @param windowSeconds  window length
 * @param opts.failClosed  refuse (Retry-After 60) instead of allowing when the
 *   counter cannot be read. For a budget whose only job is bounding guesses at
 *   a secret, where an unmetered attempt is the failure.
 */
export async function consumeRateLimit(
  bucket: string,
  login: string,
  limit: number,
  windowSeconds: number,
  opts: { failClosed?: boolean } = {},
): Promise<RateLimitVerdict> {
  const unreadable = (): RateLimitVerdict =>
    opts.failClosed ? { allowed: false, retryAfterSeconds: FAIL_CLOSED_RETRY_SECONDS } : { allowed: true };
  try {
    const raw = await upstashEval(CONSUME_SCRIPT, [rateKey(bucket, login)], [limit, windowSeconds]);
    if (!Array.isArray(raw)) return unreadable();
    const [allowed, ttl] = raw as [number, number];
    if (allowed === 1) return { allowed: true };
    // Clamp to 1: `Retry-After: 0` reads as "retry now", which is the one
    // thing this response is saying not to do.
    return { allowed: false, retryAfterSeconds: Math.max(1, Number(ttl)) };
  } catch (err) {
    console.error(`[rate-limit] ${bucket} charge failed, ${opts.failClosed ? "refusing" : "allowing"}: ${errorLabel(err)}`);
    return unreadable();
  }
}

/** Budgets, named so the routes read as policy rather than magic numbers. */
export const RATE_LIMITS = {
  /** Join-code guessing. A code is ~30 bits, so this is not what makes
   *  guessing infeasible — it is what stops a script trying anyway, and what
   *  keeps one contestant from hammering the team store. A real member joins
   *  once. */
  teamJoin: { bucket: "team-join", limit: 10, windowSeconds: 10 * 60 },
  /** Hint reveals. Purchases are atomic and idempotent, so this bounds
   *  request volume rather than protecting the charge. Set well above any
   *  human pace: a contestant clicking through every hint on a page must
   *  never hit it. */
  hintReveal: { bucket: "hint-reveal", limit: 30, windowSeconds: 60 },
  /** Admin claim attempts (`/api/me/admin/claim`), keyed on the player id and
   *  charged FAIL CLOSED. A code is 128 bits, so this is not what makes
   *  guessing infeasible; it stops a script trying. There is deliberately no
   *  global bucket: anyone could spend it and lock the organizer out of the
   *  recovery claim. */
  adminClaim: { bucket: "admin-claim", limit: 5, windowSeconds: 900 },
  /** Sign-up attempts per client address (`/sign-up/email`), charged fail
   *  closed. Sized so a venue sharing one NAT, or a CDN edge address, still
   *  fits a whole room signing up. */
  signUpIp: { bucket: "signup-ip", limit: 300, windowSeconds: 10 * 60 },
  /** Sign-in attempts per client address (`/sign-in/username`), fail closed.
   *  Coarse on purpose: it bounds a script spraying many usernames from one
   *  source without hurting a shared NAT. */
  signInIp: { bucket: "signin-ip", limit: 600, windowSeconds: 10 * 60 },
  /** Password guesses per source AND username, keyed `<ip>|<username>`, fail
   *  closed. Guessing is bounded per source, and a stranger elsewhere cannot
   *  spend a player's budget and lock them out. */
  signInUser: { bucket: "signin-user", limit: 10, windowSeconds: 15 * 60 },
  /** Username changes, keyed on the user id. */
  usernamePick: { bucket: "username-pick", limit: 20, windowSeconds: 10 * 60 },
  /** Password set/change, keyed on the user id. */
  setPassword: { bucket: "set-password", limit: 10, windowSeconds: 10 * 60 },
} as const;

/** Every rate-limit counter `player` can hold, keyed on the player's login.
 *  The admin delete clears them with the rest of the player's state. The
 *  address-keyed auth buckets are not a player's and are not listed. */
export function rateLimitKeysFor(player: string): string[] {
  return [RATE_LIMITS.teamJoin, RATE_LIMITS.hintReveal, RATE_LIMITS.adminClaim].map((r) =>
    rateKey(r.bucket, player),
  );
}
