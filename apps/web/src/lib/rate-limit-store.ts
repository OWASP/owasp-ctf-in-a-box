import "server-only";
import { errorLabel } from "@/lib/error-label";
import { upstashEval } from "@/lib/upstash";

/**
 * Per-login fixed-window rate limiter for authenticated routes.
 *
 * KEYED ON THE LOGIN, not the IP, and that is the point. An IP key is
 * spoofable here, because Caddy appends to `x-forwarded-for` rather than
 * replacing it. These routes run *after*
 * `auth.api.getSession()`, so there is a session-backed login to key on that a
 * caller cannot forge without forging the session itself.
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
 * fail-open reasoning the freeze reads use — see AGENTS.md.
 */

export type RateLimitVerdict =
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

/**
 * Charge one request against `login`'s budget for `bucket`.
 *
 * @param limit   requests allowed per window
 * @param windowSeconds  window length
 */
export async function consumeRateLimit(
  bucket: string,
  login: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitVerdict> {
  try {
    const raw = await upstashEval(CONSUME_SCRIPT, [rateKey(bucket, login)], [limit, windowSeconds]);
    const [allowed, ttl] = Array.isArray(raw) ? (raw as [number, number]) : [1, 0];
    if (allowed === 1) return { allowed: true };
    // Clamp to 1: `Retry-After: 0` reads as "retry now", which is the one
    // thing this response is saying not to do.
    return { allowed: false, retryAfterSeconds: Math.max(1, Number(ttl)) };
  } catch (err) {
    console.error(`[rate-limit] ${bucket} charge failed, allowing: ${errorLabel(err)}`);
    return { allowed: true };
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
  /** The ai module's cross-origin routes, keyed on `token.sub` — the only
   *  identity these cookie-blind endpoints have. Generous, because a legitimate
   *  external challenge may poll `/state` and retry a submission; the job is
   *  bounding a runaway or a leaked token, not rationing play. */
  aiSubmit: { bucket: "ai-submit", limit: 60, windowSeconds: 60 },
  aiEvent: { bucket: "ai-event", limit: 60, windowSeconds: 60 },
  aiState: { bucket: "ai-state", limit: 120, windowSeconds: 60 },
  /** The admin "Send test" button (`admin/ai/test/route.ts`), keyed on the
   *  admin's own login. Bounds accidental repeated clicks, not a real
   *  workload — an organizer testing one challenge's wiring has no reason to
   *  approach this in a normal session. */
  aiAdminTest: { bucket: "ai-admin-test", limit: 10, windowSeconds: 60 },
} as const;
