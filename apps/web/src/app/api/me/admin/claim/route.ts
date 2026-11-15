import { NextResponse } from "next/server";
import { claimAdmin } from "@/lib/admin-claim";
import { CLAIM_INVALID } from "@/lib/admin-claim-copy";
import { auditActor } from "@/lib/admin-audit-keys";
import { adminClaimCodeHash } from "@/lib/bootstrap-env";
import { readBoundedBody } from "@/lib/bounded-body";
import { errorLabel } from "@/lib/error-label";
import { getPlayer } from "@/lib/player";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";

/**
 * Claim an admin seat with a one-time code (ADR 73).
 *
 * Under /api/me, not /api/admin: every /api/admin route is behind
 * `requireAdmin`, and this one is how a non-admin becomes one.
 *
 * Bounds: a signed-in kit player only (401 otherwise, nothing charged), five
 * attempts per player per 15 minutes, charged FAIL CLOSED. Every refusal of a
 * code reads the same, so the answer says nothing about which codes exist.
 * The code and the hash are never logged.
 */

/** Far above a 39-character code plus JSON framing. */
const MAX_BODY_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

async function readCode(request: Request): Promise<string | null> {
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) return null;
  try {
    const body: unknown = JSON.parse(read.body);
    const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const code = await readCode(request);
  if (code === null) return json({ error: CLAIM_INVALID }, 400);

  const player = await getPlayer(request.headers);
  if (!player) return json({ error: "unauthorized" }, 401);

  const { bucket, limit, windowSeconds } = RATE_LIMITS.adminClaim;
  const budget = await consumeRateLimit(bucket, player.id, limit, windowSeconds, { failClosed: true });
  if (!budget.allowed) {
    return json({ error: "rate-limited" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  try {
    const result = await claimAdmin(code, auditActor(player), adminClaimCodeHash());
    if (result.ok) return json({ ok: true }, 200);
    if (result.reason === "already-admin") return json({ error: "already-admin" }, 409);
    return json({ error: CLAIM_INVALID }, 400);
  } catch (err) {
    console.error("[admin/claim] claim failed:", errorLabel(err));
    return json({ error: "unavailable" }, 503);
  }
}
