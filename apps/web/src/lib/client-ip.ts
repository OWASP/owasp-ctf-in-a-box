/**
 * The client address the auth rate limits key on.
 *
 * Which header carries it depends on the one trusted proxy in front of the
 * app, so the deploy path says which, through `TRUSTED_CLIENT_IP_HEADER`:
 *
 * - Unset (compose behind Caddy, AWS behind the ALB): the RIGHTMOST non-empty
 *   `x-forwarded-for` entry. Caddy and the ALB each append the peer address
 *   they saw; the entries left of it are whatever the client sent.
 * - Set (Fly, where deploy/fly/render-compose.sh sets `fly-client-ip`): that
 *   header's value, and never `x-forwarded-for`. Fly's proxy appends its own
 *   app address as the rightmost entry, so the rightmost rule would key every
 *   client on one address. It sets `Fly-Client-IP` from the connection it
 *   accepted and overwrites any client-sent copy, which holds only while it is
 *   the sole ingress to the machine.
 *
 * A missing value is "unknown", one shared key: coarser, never chosen by the
 * client. Behind an extra CDN (Cloudflare) every path keys on that CDN's edge
 * address; the auth budgets are sized so that is still safe.
 */

// An RFC 9110 field-name token. Anything else is a typo, not a header a proxy
// could have set.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * The configured header, lowercased, or null when unset. An invalid name
 * THROWS rather than reading as unset: on Fly, unset means keying every
 * client on the app's own address, a silent shared lockout. instrumentation.ts
 * calls this at startup so the server refuses to boot with the name in the
 * message, instead of failing on the first sign-in.
 */
export function trustedClientIpHeader(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.TRUSTED_CLIENT_IP_HEADER ?? "").trim();
  if (raw === "") return null;
  if (!HEADER_NAME_RE.test(raw)) {
    throw new Error(`TRUSTED_CLIENT_IP_HEADER=${JSON.stringify(raw.slice(0, 64))} is not a valid header name`);
  }
  return raw.toLowerCase();
}

const entries = (value: string | null) =>
  (value ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const trusted = trustedClientIpHeader(env);
  if (trusted !== null) return entries(headers.get(trusted))[0] ?? "unknown";
  const parts = entries(headers.get("x-forwarded-for"));
  return parts.length > 0 ? parts[parts.length - 1] : "unknown";
}
