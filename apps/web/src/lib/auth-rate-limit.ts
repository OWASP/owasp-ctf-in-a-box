import "server-only";
import { APIError, type createAuthMiddleware } from "better-auth/api";
import { clientIp } from "@/lib/client-ip";
import { RATE_LIMITS, consumeRateLimit } from "@/lib/rate-limit-store";
import { normalizeUsername } from "@/lib/username-rules";

type AuthCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

async function charge(r: { bucket: string; limit: number; windowSeconds: number }, key: string): Promise<void> {
  // Fail closed: these guard account creation and a password compare, and
  // with Redis down sign-in is down anyway.
  const verdict = await consumeRateLimit(r.bucket, key, r.limit, r.windowSeconds, { failClosed: true });
  if (verdict.allowed) return;
  const retryAfterSeconds = verdict.retryAfterSeconds;
  throw new APIError(
    "TOO_MANY_REQUESTS",
    {
      message: `Too many attempts. Try again in ${retryAfterSeconds} seconds.`,
      code: "RATE_LIMITED",
      retryAfterSeconds,
    },
    { "Retry-After": String(retryAfterSeconds) },
  );
}

/**
 * The before hook that rate-limits sign-up and username sign-in per client
 * address. Sign-in is also bounded per address AND username, so guessing one
 * account's password is limited per source while a stranger elsewhere cannot
 * lock the player out. Other paths are not charged here.
 */
export async function limitAuthAttempt(ctx: AuthCtx): Promise<void> {
  if (ctx.path === "/sign-up/email") {
    await charge(RATE_LIMITS.signUpIp, clientIp(ctx.headers ?? new Headers()));
    return;
  }
  if (ctx.path === "/sign-in/username") {
    const ip = clientIp(ctx.headers ?? new Headers());
    await charge(RATE_LIMITS.signInIp, ip);
    // Keyed on the username as the plugin stores it, so case and spaces
    // cannot buy a fresh budget for one account.
    const typed = (ctx.body as { username?: unknown } | null)?.username;
    await charge(RATE_LIMITS.signInUser, `${ip}|${typeof typed === "string" ? normalizeUsername(typed) : ""}`);
  }
}
