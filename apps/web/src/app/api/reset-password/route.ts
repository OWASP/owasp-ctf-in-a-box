import { NextResponse } from "next/server";
import { readBoundedBody } from "@/lib/bounded-body";
import { clientIp } from "@/lib/client-ip";
import { errorLabel } from "@/lib/error-label";
import { redeemPasswordResetCode } from "@/lib/password-reset";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";

/**
 * Redeem a password reset code an organizer handed over (#740), signed out.
 *
 * Outside /api/auth on purpose: better-auth's own /reset-password stays in
 * `disabledPaths` (it needs an email flow this kit does not run), and this
 * route is the kit's replacement. The proxy's origin check covers it like
 * every other `/api` route.
 *
 * Bounds: ten attempts per client address per 15 minutes, charged FAIL
 * CLOSED (`RATE_LIMITS.passwordReset`). Every refusal of a code reads the
 * same, so the answer says nothing about which codes exist. Neither the code
 * nor the password is ever logged.
 */

/** Far above a 39-character code, a 128-character password and JSON framing. */
const MAX_BODY_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** Error codes only: the /reset form owns the copy (password-reset-copy.ts
 *  and PASSWORD_COPY), so the two cannot drift. */
const INVALID = { error: "RESET_CODE_INVALID" };

async function readBody(request: Request): Promise<{ code: string; password: string } | null> {
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) return null;
  try {
    const body: unknown = JSON.parse(read.body);
    if (!body || typeof body !== "object") return null;
    const { code, password } = body as { code?: unknown; password?: unknown };
    return typeof code === "string" && typeof password === "string" ? { code, password } : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const body = await readBody(request);
  if (body === null) return json(INVALID, 400);

  const { bucket, limit, windowSeconds } = RATE_LIMITS.passwordReset;
  const budget = await consumeRateLimit(bucket, clientIp(request.headers), limit, windowSeconds, { failClosed: true });
  if (!budget.allowed) {
    return json({ error: "RATE_LIMITED" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  try {
    const result = await redeemPasswordResetCode(body.code, body.password);
    if (result.ok) return json({ ok: true }, 200);
    if (result.reason === "password") return json({ error: "PASSWORD_LENGTH" }, 400);
    return json(INVALID, 400);
  } catch (err) {
    console.error("[reset-password] redeem failed:", errorLabel(err));
    return json({ error: "unavailable" }, 503);
  }
}
