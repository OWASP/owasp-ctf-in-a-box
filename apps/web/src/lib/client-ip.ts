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
 * client. Behind Cloudflare's proxy every path above yields a Cloudflare edge
 * address, so a whole venue would share one bucket; `CLOUDFLARE_ORIGIN_SECRET`
 * (see clientIp below) reads the player's address from `CF-Connecting-IP`
 * instead, only for requests that prove they came through the event's zone.
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

/** The request header the event's Cloudflare zone sets, through a Transform
 *  Rule, to `CLOUDFLARE_ORIGIN_SECRET` on every request it proxies. */
export const CLOUDFLARE_ORIGIN_HEADER = "x-ctf-origin-secret";

/**
 * The origin secret from `CLOUDFLARE_ORIGIN_SECRET`, or null when unset (the
 * box is not behind Cloudflare, or the organizer has not set it up).
 *
 * A Cloudflare edge address alone does not prove a request came through the
 * EVENT's zone: a Worker on any Cloudflare account can call the origin
 * directly (the fly.dev hostname, the ALB's DNS name) and, Cloudflare
 * documents, set CF-Connecting-IP to anything. Only the event's own zone knows
 * this value, so a request carrying it went through that zone.
 *
 * A value shorter than 32 characters or with whitespace THROWS rather than
 * reading as unset: instrumentation.ts calls this at startup so the server
 * refuses to boot. The value itself is never part of the message.
 */
export function cloudflareOriginSecret(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.CLOUDFLARE_ORIGIN_SECRET ?? "";
  if (raw.trim() === "") return null;
  if (raw.length < 32 || /\s/.test(raw)) {
    throw new Error("CLOUDFLARE_ORIGIN_SECRET must be at least 32 characters with no whitespace (e.g. openssl rand -hex 32)");
  }
  return raw;
}

/** Constant-time string equality. No node:crypto: this module also loads in
 *  the Edge runtime through instrumentation.ts. */
function sameSecret(given: string, want: string): boolean {
  let diff = given.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= (given.charCodeAt(i) || 0) ^ want.charCodeAt(i);
  return diff === 0;
}

// Cloudflare's published edge ranges, https://www.cloudflare.com/ips/ (checked
// 2026-11-24). A request whose proxy-vouched peer is in one of these came
// through Cloudflare, which overwrites any client-sent CF-Connecting-IP. If
// Cloudflare adds a range, a player routed through it only falls back to the
// shared edge bucket; nothing is trusted that should not be.
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

/** An IPv4 address as a 32-bit bigint, or null when it is not one. */
function v4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = BigInt(0);
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << BigInt(8)) + BigInt(Number(p));
  }
  return n;
}

/** An IPv6 address as a 128-bit bigint, or null when it is not one. No
 *  embedded-IPv4 or zone forms: Cloudflare sends neither. */
function v6(ip: string): bigint | null {
  if (!/^[0-9a-f:]+$/i.test(ip) || ip.split("::").length > 2) return null;
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, undefined];
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << BigInt(16)) + BigInt(parseInt(g, 16));
  }
  return n;
}

function inRanges(ip: string, ranges: string[], parse: (s: string) => bigint | null, bits: number): boolean {
  const addr = parse(ip);
  if (addr === null) return false;
  return ranges.some((cidr) => {
    const [base, len] = cidr.split("/");
    const shift = BigInt(bits - Number(len));
    return addr >> shift === (parse(base) as bigint) >> shift;
  });
}

/** Whether `ip` is inside Cloudflare's published edge ranges. */
export function isCloudflareAddress(ip: string): boolean {
  return inRanges(ip, CLOUDFLARE_V4, v4, 32) || inRanges(ip, CLOUDFLARE_V6, v6, 128);
}

const isIp = (s: string) => v4(s) !== null || v6(s) !== null;

/**
 * The proxy-vouched peer by the rules above, then, behind Cloudflare, the
 * player's own address from `CF-Connecting-IP`. That header is read only when
 * the request carries the zone's origin secret AND the peer is a Cloudflare
 * edge. A client reaching the origin directly (the Fly origin answers around
 * Cloudflare, see docs/fly.md), or through another account's Worker, can set
 * CF-Connecting-IP to anything and would otherwise pick a fresh rate-limit
 * bucket per request.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const trusted = trustedClientIpHeader(env);
  let peer: string;
  if (trusted !== null) {
    peer = entries(headers.get(trusted))[0] ?? "unknown";
  } else {
    const parts = entries(headers.get("x-forwarded-for"));
    peer = parts.length > 0 ? parts[parts.length - 1] : "unknown";
  }
  const secret = cloudflareOriginSecret(env);
  if (secret !== null && sameSecret(headers.get(CLOUDFLARE_ORIGIN_HEADER) ?? "", secret) && isCloudflareAddress(peer)) {
    const cf = (headers.get("cf-connecting-ip") ?? "").trim();
    if (isIp(cf)) return cf;
  }
  return peer;
}
