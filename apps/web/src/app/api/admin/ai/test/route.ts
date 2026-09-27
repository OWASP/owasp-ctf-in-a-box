import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import { resolveOrigin } from "@/lib/app-origin";
import { getAiLaunchKeys, getAiSigningKey, listAiChallenges } from "@/lib/ai-store";
import { signEventBody, signLaunchToken, type AiTokenClaims } from "@/lib/ai-token";
import { getLaunchAccess } from "@/lib/launch";
// The REAL event handler — invoked in-process, never over the network. See
// the header comment below: this route relays its verdict verbatim rather
// than re-implementing any of its verification.
import { POST as eventPost } from "@/app/api/ai/event/route";
import { RATE_LIMITS, consumeRateLimit } from "@/lib/rate-limit-store";

/**
 * The organizer's "Send test" button for one ai-module challenge (spec §8.2).
 *
 * Mints a 15-minute demo launch token for the ADMIN'S OWN login, signs a demo
 * solve-event body with the challenge's real signing key, and calls the REAL
 * `/api/ai/event` handler in-process — the exact code path a live integration
 * exercises — with `dryRun: true`, hard-coded here and NEVER taken from the
 * caller's body: this route's whole safety story is that dryRun cannot be
 * turned off from the outside, and the identity minted into the token is
 * always the calling admin's own login, never a caller-supplied `sub`. A dry
 * run writes nothing (see `event/route.ts`'s own doc comment), which is what
 * makes this safe to click against a live event: no nonce is claimed, no
 * points are awarded.
 *
 * This route deliberately does NOT re-implement any of `/api/ai/event`'s
 * checks (signature, token, mode, rate limit, team, schedule). It relays that
 * handler's status and JSON body verbatim, including a refusal — a
 * flag-mode challenge's `wrong-mode`, say — so the admin panel always shows
 * the same verdict a real integration would get, never a synthetic one this
 * route invented. The ONE exception is the pre-invocation signing-key check
 * below: it has to run before the event handler is even reachable (there is
 * no key to sign the demo event with otherwise), so its `no-signing-key`
 * refusal is this route's own, not a relay — see that check's comment.
 *
 * `requireAdmin` runs FIRST, before any store read, mint or invocation:
 * exactly `admin/ai/route.ts`'s idiom, because minting a token — even a
 * throwaway demo one — is a write-shaped operation that must never run for
 * an unauthenticated caller.
 *
 * The launch PRIVATE key (from `getAiLaunchKeys`) and the challenge's event
 * signing key are used only to produce signatures; neither is ever placed in
 * the response body or handed to `console.error`.
 */

const RESULT_ERROR = "unavailable";

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const { bucket, limit, windowSeconds } = RATE_LIMITS.aiAdminTest;
  const budget = await consumeRateLimit(bucket, gate.login, limit, windowSeconds);
  if (!budget.allowed) return NextResponse.json({ error: "rate-limited" }, { status: 429 });

  const body = await request.json().catch(() => null);
  const challengeId =
    body !== null && typeof body === "object" && typeof (body as { challengeId?: unknown }).challengeId === "string"
      ? (body as { challengeId: string }).challengeId
      : "";

  // The three store reads below (challenge lookup, signing key, launch keys)
  // share one try/catch: a store outage on ANY of them must answer the
  // route's own declared 503 `{error:"unavailable"}`, never escape as a
  // framework 500 — the admin panel's classifier only understands this
  // route's JSON error shapes, and a 500 has no body for it to read.
  let challenge: Awaited<ReturnType<typeof listAiChallenges>>[number] | undefined;
  let signingKey: Awaited<ReturnType<typeof getAiSigningKey>>;
  let launchPrivateKey: string;
  try {
    challenge = (await listAiChallenges()).find((c) => c.id === challengeId);
    if (!challenge) return NextResponse.json({ error: "unknown-challenge" }, { status: 400 });

    // A challenge can exist with no signing key yet minted (a legacy row —
    // see `AdminAiChallenge`'s doc comment). There is nothing to sign a demo
    // event with in that case, so this has to be refused HERE, before the
    // real event handler is ever invoked — the one place this route answers
    // on its own rather than relaying that handler's verdict (see the header
    // comment). `unknown-challenge` would be dishonest: the organizer is
    // looking at a real row, on a real challenge, that just has no signing
    // key yet — and it would also be wrong for a flag-mode challenge, which
    // the real pipeline would refuse with `wrong-mode` first (mode is
    // checked before the signing key is even read — see `event/route.ts`).
    // This route cannot reproduce that ordering without re-implementing the
    // mode check, so it names its own refusal instead of guessing at the
    // real one.
    signingKey = await getAiSigningKey(challengeId);
    if (!signingKey) return NextResponse.json({ error: "no-signing-key" }, { status: 400 });

    launchPrivateKey = (await getAiLaunchKeys()).privateKey;
  } catch (err) {
    console.error("[admin/ai/test] store read failed:", adminErrorLabel(err));
    return NextResponse.json({ error: RESULT_ERROR }, { status: 503 });
  }

  // Before launch (#464) the admin is only a preview: mint the demo token
  // with the signed `ctf.preview` claim so the dry run is graded while
  // scoring is closed — otherwise every pre-launch Send test says "paused".
  const { preview } = await getLaunchAccess(gate.login);
  const now = Math.floor(Date.now() / 1000);
  const claims: AiTokenClaims = {
    iss: resolveOrigin(),
    sub: gate.login,
    aud: challengeId,
    iat: now,
    exp: now + 900,
    jti: randomBytes(16).toString("base64url"),
    ctf: {
      module: "ai",
      challenge: { id: challenge.id, title: challenge.title, points: challenge.points },
      points: 0,
      progress: [],
      ...(preview ? { preview: true as const } : {}),
    },
  };
  const token = signLaunchToken(claims, launchPrivateKey);

  const eventBody = JSON.stringify({
    token,
    challengeId,
    solvedAt: new Date().toISOString(),
    dryRun: true,
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = signEventBody(signingKey, ts, eventBody);

  const eventRequest = new Request("http://internal/api/ai/event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-CTF-Timestamp": String(ts),
      "X-CTF-Signature": sig,
    },
    body: eventBody,
  });

  const eventResponse = await eventPost(eventRequest);
  const eventJson = await eventResponse.json().catch(() => null);

  await writeAdminAudit(gate.login, "ai-send-test", { id: challengeId });

  return NextResponse.json({ status: eventResponse.status, body: eventJson });
}
