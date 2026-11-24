import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readBoundedBody } from "@/lib/bounded-body";
import { errorLabel } from "@/lib/error-label";
import { getPlayerForWrite } from "@/lib/player";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";
import { setUsernameOnce } from "@/lib/username-store";

/**
 * Pick a username after a first OAuth sign-in. Under /api/me, signed in only.
 *
 * 200 and 409 already_set carry refreshed session cookies: the session cookie
 * cache lasts five minutes, and a cache minted before the pick (in this
 * browser, or in another one for already_set) would keep serving a user with
 * no username, bouncing them back to /welcome until it lapsed. When the
 * refresh fails, the cache cookie is expired instead, so the next request
 * reads the store; the session-token cookie is left alone.
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

/** Re-signs the cookie cache from the store onto `res`, or expires it (every
 *  chunk the browser sent) when that read fails. */
async function refreshSessionCookies(request: Request, res: NextResponse): Promise<void> {
  try {
    // Past the cookie cache, so the re-read comes from the store and the
    // response re-signs the cache with the updated user.
    const fresh = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    for (const cookie of fresh.headers.getSetCookie()) res.headers.append("Set-Cookie", cookie);
    return;
  } catch (err) {
    console.error(`[username] session refresh failed, expiring the cookie cache: ${errorLabel(err)}`);
  }
  try {
    const { name, attributes } = (await auth.$context).authCookies.sessionData;
    const sent = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((c) => c.split("=")[0].trim())
      .filter((n) => n.startsWith(`${name}.`));
    for (const n of [name, ...sent]) {
      res.cookies.set(n, "", { ...attributes, sameSite: attributes.sameSite as "lax" | "strict" | "none" | undefined, maxAge: 0 });
    }
  } catch (err) {
    // The username is stored either way; the cache lapses within minutes.
    console.error(`[username] cookie cache expiry failed: ${errorLabel(err)}`);
  }
}

export async function POST(request: Request) {
  const player = await getPlayerForWrite(request.headers);
  if (!player) return json({ error: "unauthorized" }, 401);

  const username = await readUsername(request);
  if (username === null) return json({ error: "invalid" }, 400);

  // Fail open (consumeRateLimit's default), like /api/team/join: the budget
  // bounds request volume, and setUsernameOnce refuses on its own.
  const { bucket, limit, windowSeconds } = RATE_LIMITS.usernamePick;
  const budget = await consumeRateLimit(bucket, player.id, limit, windowSeconds);
  if (!budget.allowed) {
    return json({ error: "rate-limited" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  let result: Awaited<ReturnType<typeof setUsernameOnce>>;
  try {
    result = await setUsernameOnce(player.id, username);
  } catch (err) {
    console.error(`[username] pick failed: ${errorLabel(err)}`);
    return json({ error: "unavailable" }, 500);
  }
  if (result === "invalid") return json({ error: "invalid" }, 400);
  if (result === "taken") return json({ error: "taken" }, 409);

  const res = result === "ok" ? json({ ok: true }, 200) : json({ error: "already_set" }, 409);
  await refreshSessionCookies(request, res);
  return res;
}
