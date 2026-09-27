import { logActivity } from "@/lib/activity-log";
import { AI_ID_RE } from "@/lib/ai-keys";
import { aiAwardResponse, aiJson, aiPreflight, aiRoute, readRawBody } from "@/lib/ai-http";
import { previewClaimStillValid } from "@/lib/ai-preview";
import { getAiLaunchPublicKey, listAiChallenges, submitAiFlag } from "@/lib/ai-store";
import { decodeTokenUnverified, verifyLaunchToken } from "@/lib/ai-token";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";
import { hasTeam } from "@/lib/team-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard cap on a submitted flag's length, checked BEFORE the store ever sees
 *  it. Mirrors `classic/submit/route.ts`'s `FLAG_MAX_LEN`. */
const FLAG_MAX_LEN = 512;

const ALLOWED_METHODS = "POST, OPTIONS";

/**
 * Submits one flag against one ai challenge, on behalf of an externally
 * hosted challenge acting for a player.
 *
 * COOKIE-BLIND BY DESIGN. This route never imports `@/lib/auth`,
 * `next/headers` or `@/lib/launch`, and reads no cookie at all —
 * identity is `token.sub`, the launch token's subject, and nothing else. That
 * is what makes CORS `*` on this endpoint safe rather than a CSRF hole: a
 * forged cross-site POST carries no session to ride on, because there is no
 * session-based check here to bypass. `src/proxy.ts` exempts `/api/ai/` from
 * the app's usual same-origin enforcement on exactly this reasoning — see its
 * `AI_PREFIX` comment. If this route ever starts reading a cookie, that
 * exemption becomes a hole, not a convenience.
 *
 * The pre-launch lock (#464) is enforced once, at token-mint time, not here —
 * see spec §6.5. A launch token in hand already proves the box minted it
 * after that lock passed; this route does not re-check it, the same way it
 * does not re-check any other launch-time decision. (Scoring itself is still
 * closed before launch: `submitAiFlag`'s pause check reads the same missing
 * scoring start as "not launched".)
 *
 * That enforcement is an EXPLICIT `redirectIfNotLaunched()` call in
 * `(site)/ai/[id]/page.tsx`, above the mint (and a second check in that
 * page's `actions.ts`, the in-box form's server half). The proxy guards no
 * module pages at all.
 *
 * `submitAiFlag` remains authoritative on pause, cooldown, already-solved and
 * grading — its Lua script re-checks all of that atomically. This route
 * re-implements none of it; it only:
 *   - validates the body shape (400 `invalid-request`)
 *   - reads the challenge id from the token's `aud`, unverified, to select
 *     which public key and audience to verify against (401 `invalid-token`
 *     for a missing or malformed `aud`)
 *   - verifies the token against the module's launch public key — no
 *     per-challenge secret is read on this path at all, because a launch
 *     token is proof the box minted it and the flag itself is the
 *     proof-of-solve (401 `invalid-token` / `expired`)
 *   - rate limits per `token.sub` (429, `Retry-After`)
 *   - resolves the challenge and its `mode` via `listAiChallenges()` (404
 *     `unknown-challenge`; 409 `wrong-mode` for an event-only challenge)
 *   - checks `hasTeam(claims.sub)` — a ROUTE-level check PR 1's store never
 *     took on, matching `classic/submit/route.ts`'s split exactly (403
 *     `no-team`, failing OPEN so a Redis blip lets a solve through rather
 *     than drop it)
 *   - calls `submitAiFlag` and maps its result with `aiAwardResponse`
 *
 * The pipeline never lets a refusal follow a write: every check above runs
 * before `submitAiFlag` is called, and `submitAiFlag` itself never carries
 * the flag back in its result — there is no field here to leak a submitted or
 * stored flag through.
 *
 * Wrapped in `aiRoute`, so a store read that THROWS (an Upstash blip) leaves
 * here as a CORS-readable 503 `{error:"unavailable"}` rather than a bare 500
 * an external caller cannot even see the status of.
 */
export const POST = aiRoute(async (request: Request): Promise<Response> => {
  const body = await readRawBody(request);
  if (!body.ok) return aiJson({ error: "invalid-request" }, 400);

  const token = body.parsed.token;
  const flag = body.parsed.flag;
  if (typeof token !== "string" || typeof flag !== "string" || !flag.trim() || flag.length > FLAG_MAX_LEN) {
    return aiJson({ error: "invalid-request" }, 400);
  }

  const unverified = decodeTokenUnverified(token);
  const aud = unverified?.aud;
  if (typeof aud !== "string" || !AI_ID_RE.test(aud)) {
    return aiJson({ error: "invalid-token" }, 401);
  }

  const publicKey = await getAiLaunchPublicKey();
  const check = verifyLaunchToken(token, publicKey, { audience: aud });
  if (!check.ok) {
    if (check.error === "expired") return aiJson({ error: "expired" }, 401);
    // invalid-signature | malformed | audience
    return aiJson({ error: "invalid-token" }, 401);
  }
  const { claims } = check;
  // A token minted for an admin preview (#464) is honoured only while the
  // event is not launched; after launch it is refused (the player re-launches
  // for a normal token) — never graded dry, never graded for real.
  const preview = claims.ctf?.preview === true;
  if (preview && !(await previewClaimStillValid())) return aiJson({ error: "invalid-token" }, 401);

  const rl = RATE_LIMITS.aiSubmit;
  const limited = await consumeRateLimit(rl.bucket, claims.sub, rl.limit, rl.windowSeconds);
  if (!limited.allowed) {
    return aiJson({ error: "rate-limited" }, 429, { "Retry-After": String(limited.retryAfterSeconds) });
  }

  const challenges = await listAiChallenges();
  const challenge = challenges.find((c) => c.id === aud);
  if (!challenge) return aiJson({ error: "unknown-challenge" }, 404);
  if (challenge.mode === "event") return aiJson({ error: "wrong-mode" }, 409);

  // Scoring is per team; a teamless subject's banked points fold into no team
  // total. Route-level, matching classic/submit — see file header. Runs after
  // every check above that can be answered from the token and the challenge
  // list alone, and before the only write in this pipeline.
  // A preview skips it: a dry run banks nothing to fold into a team, and
  // organizers usually have none.
  if (!preview && !(await hasTeam(claims.sub))) {
    return aiJson({ error: "no-team" }, 403);
  }

  // A token minted for an admin preview (#464) is graded as a dry run: the
  // same script, writing nothing. The claim is signed, so a contestant cannot
  // add it to their own token.
  const result = await submitAiFlag(claims.sub, aud, flag, { dryRun: preview });
  // Activity log (issue #212): fresh solves only — an idempotent
  // re-submission banked nothing and would double-count the event. The id
  // and the path, never the flag; logActivity is fail-open, so it cannot
  // fail an award that already landed. Mirrors classic/submit's guard.
  // Never for a dry run (#464 admin preview): nothing was solved.
  if (result.ok && result.correct && !result.already && !result.dryRun) {
    await logActivity("ai-solve", claims.sub, `${aud} via flag`);
  }
  return aiAwardResponse(result);
});

export async function OPTIONS(): Promise<Response> {
  return aiPreflight(ALLOWED_METHODS);
}
