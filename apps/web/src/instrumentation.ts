import { trustedClientIpHeader } from "@/lib/client-ip";
import { checkEventUrl } from "@/lib/secure-url";

/**
 * Next's server-startup hook: called once per server instance, and completes
 * before the first request is served.
 *
 * This is the right home for the EVENT_URL check specifically because of that
 * timing. Validating inside `lib/auth.ts` at import would also run during
 * `next build` (which sets NODE_ENV=production), turning a deployment warning
 * into a build failure on a machine that has no event config at all. Checking
 * per-request would be too late — by the first request the cookie policy is
 * already settled, and an organizer would learn about it from a log line
 * buried under traffic instead of a server that refused to come up.
 *
 * The Edge runtime loads this file too; the check is pure string work with no
 * Node built-ins, so it runs identically in both.
 */
export function register() {
  // Throws on a malformed TRUSTED_CLIENT_IP_HEADER, refusing to boot rather
  // than keying every client on one address (see client-ip.ts).
  trustedClientIpHeader();

  const verdict = checkEventUrl({
    url: process.env.BETTER_AUTH_URL,
    nodeEnv: process.env.NODE_ENV,
    allowInsecure: process.env.ALLOW_INSECURE_EVENT_URL === "1",
  });

  if (verdict.level === "ok") return;

  if (verdict.level === "warn") {
    console.warn(`⚠️  ctf-app: ${verdict.message}`);
    return;
  }

  // Throwing here stops the server before it serves anything. That is the
  // intent: an event that boots with sniffable organizer sessions and no
  // symptom is worse than one that refuses to boot with a message naming the
  // fix.
  throw new Error(`ctf-app: ${verdict.message}`);
}
