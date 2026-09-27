import { logActivity } from "@/lib/activity-log";
import { aiAwardResponse, aiJson, aiPreflight, aiRoute, readRawBody } from "@/lib/ai-http";
import { AI_ID_RE } from "@/lib/ai-keys";
// Kept on ONE line deliberately: contract.test.ts's cookie-blindness and
// secret-reader greps run over `import` LINES, and a wrapped list would need
// the join-then-match treatment noted there.
import { awardAiEvent, claimAiNonce, getAiLaunchPublicKey, getAiSigningKey, listAiChallenges, releaseAiNonce } from "@/lib/ai-store";
import { verifyEventSignature, verifyLaunchToken, withinSkew } from "@/lib/ai-token";
import { RATE_LIMITS, consumeRateLimit } from "@/lib/rate-limit-store";
import { hasTeam } from "@/lib/team-store";

/**
 * Records a solve ASSERTED by an externally hosted challenge's backend.
 *
 * TWO PROOFS, NEITHER SUFFICIENT ALONE. The HMAC signature over the raw body
 * proves the SENDER is the real challenge backend (it holds that challenge's
 * symmetric signing key). The launch token proves WHO is playing — it is
 * Ed25519 and only the box holds the private half, so a backend cannot mint
 * one naming a player who never opened the challenge. A leaked signing key
 * therefore cannot invent users; a leaked token cannot sign.
 *
 * COOKIE-BLIND, like the module's other routes: no session is read, so a
 * cross-site POST carries no ambient credential and CSRF is out of scope by
 * construction. `proxy.ts` exempts this prefix from its same-origin assertion
 * for that reason.
 *
 * `solvedAt` in the body is ADVISORY. The awarded time is the box's own
 * clock, so an external system cannot backdate itself onto a first blood.
 *
 * Wrapped in `aiRoute`, so a store read that THROWS (an Upstash blip) leaves
 * here as a CORS-readable 503 `{error:"unavailable"}` rather than a bare 500
 * an external caller cannot even see the status of.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return aiPreflight("POST, OPTIONS");
}

export const POST = aiRoute(async (request: Request): Promise<Response> => {
  // 1. Raw bytes first — the signature covers exactly what arrived.
  const body = await readRawBody(request);
  if (!body.ok) return aiJson({ error: "invalid-request" }, 400);

  const token = typeof body.parsed.token === "string" ? body.parsed.token : "";
  const challengeId = typeof body.parsed.challengeId === "string" ? body.parsed.challengeId : "";
  if (!token || !AI_ID_RE.test(challengeId)) return aiJson({ error: "invalid-request" }, 400);

  // `dryRun` means do-not-write. A present-but-non-boolean value (a templated
  // integration sending the STRING "true", say) must refuse rather than fall
  // through to `false` — that direction fails toward a real award and a
  // burned jti, exactly backwards for a field whose whole point is safety.
  const dryRunRaw = body.parsed.dryRun;
  if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
    return aiJson({ error: "invalid-request" }, 400);
  }
  const dryRun = dryRunRaw === true;

  // 2. The challenge, and whether this path is live for it.
  const challenge = (await listAiChallenges()).find((c) => c.id === challengeId);
  if (!challenge) return aiJson({ error: "unknown-challenge" }, 404);
  if (challenge.mode === "flag") return aiJson({ error: "wrong-mode" }, 409);

  const signingKey = await getAiSigningKey(challengeId);
  if (!signingKey) return aiJson({ error: "unknown-challenge" }, 404);

  // 3. Signature BEFORE token: a caller who cannot prove it is the backend
  //    learns nothing about the token it presented.
  const tsRaw = (request.headers.get("x-ctf-timestamp") ?? "").trim();
  const ts = Number(tsRaw);
  const signature = request.headers.get("x-ctf-signature") ?? "";
  if (!tsRaw || !Number.isFinite(ts)) return aiJson({ error: "stale-request" }, 401);
  if (!verifyEventSignature(signingKey, ts, body.raw, signature)) {
    return aiJson({ error: "invalid-signature" }, 401);
  }

  // 4. Clock skew, both directions.
  if (!withinSkew(ts, Math.floor(Date.now() / 1000))) return aiJson({ error: "stale-request" }, 401);

  // 5. Who is playing. The audience check is what stops a token minted for a
  //    cheap challenge being replayed against an expensive one.
  const verified = verifyLaunchToken(token, await getAiLaunchPublicKey(), { audience: challengeId });
  if (!verified.ok) {
    return aiJson({ error: verified.error === "expired" ? "expired" : "invalid-token" }, 401);
  }
  const login = verified.claims.sub;
  // A token minted for an admin preview (#464) is always a dry run — even when
  // the body asks for a real award — and is graded while scoring is closed.
  const preview = verified.claims.ctf?.preview === true;
  const dry = dryRun || preview;

  // 6. Budget, charged before any write.
  const { bucket, limit, windowSeconds } = RATE_LIMITS.aiEvent;
  const budget = await consumeRateLimit(bucket, login, limit, windowSeconds);
  if (!budget.allowed) {
    return aiJson({ error: "rate-limited" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  // 7. Team membership, route-level and fail-open, as on /submit. Checked
  //    BEFORE the nonce claim: a teamless refusal must not spend the jti — a
  //    solver who joins a team and retries the SAME launch token would
  //    otherwise get `409 replay` for the token's whole TTL.
  if (!(await hasTeam(login))) return aiJson({ error: "no-team" }, 403);

  // 8. Replay. Claimed immediately before the award — any earlier (e.g. above
  //    the team check) would spend the jti on a refusal that never awarded;
  //    any later would let a replayed request award twice under a race.
  //    Skipped entirely for a dry run, because a claimed nonce is a write and
  //    would burn the organizer's jti.
  if (!dry && !(await claimAiNonce(verified.claims.jti))) {
    return aiJson({ error: "replay" }, 409);
  }

  // 9. The award itself, atomic in the store.
  const result = await awardAiEvent(login, challengeId, { dryRun, preview });

  if (dry) {
    const wouldAward = result.ok && result.correct === true;
    return aiJson({
      dryRun: true,
      wouldAward,
      verdict: wouldAward ? "would-award" : result.ok ? "would-refuse" : result.reason,
      checks: ["body", "challenge", "mode", "signature", "timestamp", "token", "rate-limit", "team", "schedule"],
    });
  }

  // Activity log (issue #212): fresh solves only — an `already` award banked
  // nothing further and would double-count the event, and the dryRun branch
  // above has already returned, so this can only see a real attempt. The id
  // and the path, never the flag; logActivity is fail-open, so it cannot
  // fail an award that already landed. Mirrors classic/submit's guard.
  if (result.ok && result.correct && !result.already) {
    await logActivity("ai-solve", login, `${challengeId} via event`);
  }

  // 10. The nonce guards the replay of an award that HAPPENED. If the award did
  //     NOT land — paused, unavailable, a store error — the jti is spent for
  //     nothing, and the integrator's retry (standard on a 5xx) would get
  //     `409 replay` forever: a backend-driven integration holds ONE token per
  //     launch and could never land that solve. So release it.
  //
  //     Safe because `AWARD_SCRIPT` is idempotent — a retry that lands twice
  //     answers `already: true` rather than paying twice — and every auth check
  //     above re-runs on the retry, so releasing grants no bypass. `ok: true`
  //     (including `already`) keeps the nonce: that award DID happen.
  //     `releaseAiNonce` never throws; a failed release just means the
  //     integrator re-launches.
  if (!result.ok) await releaseAiNonce(verified.claims.jti);

  return aiAwardResponse(result);
});
