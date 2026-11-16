/**
 * The client address a rate limit keys on: the RIGHTMOST non-empty entry of
 * `x-forwarded-for`, else "unknown".
 *
 * Every deploy path has exactly one trusted proxy in front of the app (Caddy
 * on compose, Fly's proxy, the AWS ALB) and each appends the peer address it
 * saw. The leftmost entries are whatever the client sent, so only the
 * rightmost is one a client cannot choose. Behind an extra CDN it is that
 * CDN's edge address, which only makes a limit coarser; the auth budgets are
 * sized so that is still safe.
 */
export function clientIp(headers: Headers): string {
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1] : "unknown";
}
