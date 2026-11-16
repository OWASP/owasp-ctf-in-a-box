import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readBoundedBody } from "@/lib/bounded-body";
import { errorLabel } from "@/lib/error-label";
import { getPlayer } from "@/lib/player";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";
import { setUsernameOnce } from "@/lib/username-store";

/**
 * Pick a username after a first OAuth sign-in. Under /api/me, signed in only.
 *
 * 200 carries refreshed session cookies: the session cookie cache lasts five
 * minutes, and a cache minted before the pick would keep serving a user with
 * no username (and bounce them back to /welcome) until it lapsed.
 */

const MAX_BODY_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

async function readUsername(request: Request): Promise<string | null> {
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) return null;
  try {
    const body: unknown = JSON.parse(read.body);
    const username = body && typeof body === "object" ? (body as { username?: unknown }).username : undefined;
    return typeof username === "string" ? username : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return json({ error: "unauthorized" }, 401);

  const username = await readUsername(request);
  if (username === null) return json({ error: "invalid" }, 400);

  const { bucket, limit, windowSeconds } = RATE_LIMITS.usernamePick;
  const budget = await consumeRateLimit(bucket, player.id, limit, windowSeconds);
  if (!budget.allowed) {
    return json({ error: "rate-limited" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  try {
    const result = await setUsernameOnce(player.id, username);
    if (result === "invalid") return json({ error: "invalid" }, 400);
    if (result !== "ok") return json({ error: result }, 409);
  } catch (err) {
    console.error(`[username] pick failed: ${errorLabel(err)}`);
    return json({ error: "unavailable" }, 500);
  }

  const res = json({ ok: true }, 200);
  try {
    // Past the cookie cache, so the re-read comes from the store and the
    // response re-signs the cache with the updated user.
    const fresh = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    for (const cookie of fresh.headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
  } catch (err) {
    // The pick is stored; the cache just lapses on its own within minutes.
    console.error(`[username] session refresh failed: ${errorLabel(err)}`);
  }
  return res;
}
