import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readBoundedBody } from "@/lib/bounded-body";
import { errorLabel } from "@/lib/error-label";
import { accountExists } from "@/lib/account-exists";
import { getPlayer } from "@/lib/player";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";

/**
 * Add a password to an account that has none (a GitHub sign-in). Under
 * /api/me, signed in only.
 *
 * `auth.api.setPassword` is better-auth's server-only endpoint: it is not
 * mounted over HTTP, enforces the configured length bounds, and refuses when
 * a credential account with a password already exists, so this can never
 * replace a password. Nothing on this path logs or echoes the password.
 */

// 128 characters at up to 4 bytes each, plus the JSON envelope.
const MAX_BODY_BYTES = 2048;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

async function readNewPassword(request: Request): Promise<string | null> {
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) return null;
  try {
    const body: unknown = JSON.parse(read.body);
    const value = body && typeof body === "object" ? (body as { newPassword?: unknown }).newPassword : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function apiErrorCode(err: unknown): string | null {
  const code = (err as { body?: { code?: unknown } } | null)?.body?.code;
  return typeof code === "string" ? code : null;
}

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return json({ error: "unauthorized" }, 401);

  const newPassword = await readNewPassword(request);
  if (newPassword === null) return json({ error: "invalid" }, 400);

  // Fail open (consumeRateLimit's default), like /api/team/join: the budget
  // bounds request volume, and setPassword refuses on its own.
  const { bucket, limit, windowSeconds } = RATE_LIMITS.setPassword;
  const budget = await consumeRateLimit(bucket, player.id, limit, windowSeconds);
  if (!budget.allowed) {
    return json({ error: "rate-limited" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  try {
    // The account check sits right before the write, after the body is read:
    // a deleted player's cached session passes getPlayer, and a slow body
    // must not widen the gap between the check and the write.
    if (!(await accountExists(player.id))) return json({ error: "unauthorized" }, 401);
    await auth.api.setPassword({ headers: request.headers, body: { newPassword } });
  } catch (err) {
    const code = apiErrorCode(err);
    if (code === "PASSWORD_ALREADY_SET") return json({ error: "already_set" }, 409);
    if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") return json({ error: "length" }, 400);
    console.error(`[password] set failed: ${errorLabel(err)}`);
    return json({ error: "unavailable" }, 500);
  }
  return json({ ok: true }, 200);
}
