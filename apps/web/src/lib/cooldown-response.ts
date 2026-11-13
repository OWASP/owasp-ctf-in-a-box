import { NextResponse } from "next/server";

/**
 * Whole seconds remaining until an ISO-8601 `retryAt` instant, rounded up so a
 * client retrying after `Retry-After` seconds never lands back inside the same
 * cooldown window. Clamped to at least 1 so `Retry-After: 0` never reads as
 * "retry immediately" (mirrors `consumeRateLimit` in `rate-limit-store.ts`).
 */
export function retryAfterSeconds(retryAt: string | undefined, nowMs: number = Date.now()): number {
  if (!retryAt) return 1;
  const retryMs = Date.parse(retryAt);
  if (!Number.isFinite(retryMs)) return 1;
  return Math.max(1, Math.ceil((retryMs - nowMs) / 1000));
}

/**
 * Builds the HTTP 429 cooldown refusal response with a `Retry-After` header in
 * whole seconds while preserving `{ error: "cooldown", retryAt }` in the body.
 */
export function cooldownResponse(retryAt?: string, nowMs: number = Date.now()): NextResponse {
  const body = retryAt ? { error: "cooldown", retryAt } : { error: "cooldown" };
  return NextResponse.json(body, {
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds(retryAt, nowMs)) },
  });
}
