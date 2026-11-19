import { trustedClientIpHeader } from "@/lib/client-ip";
import { configuredProviders } from "@/lib/sign-in-providers";
import { checkEventUrl } from "@/lib/secure-url";

/**
 * Next's server-startup hook: called once per server instance, and completes
 * before the first request is served.
 *
 * The Edge runtime loads this file too, so Node-only Redis compatibility
 * checks are dynamically imported only in the Node.js runtime.
 */
export async function register(): Promise<void> {
  // Throws on a malformed TRUSTED_CLIENT_IP_HEADER, refusing to boot rather
  // than keying every client on one address (see client-ip.ts).
  trustedClientIpHeader();

  // Quiz and classic still serve without GitHub keys, so this logs rather
  // than refusing to boot.
  if ((process.env.SCORE_IMAGE ?? "").trim() !== "" && !configuredProviders().includes("github")) {
    console.error(
      "[startup] Secure Development is on (SCORE_IMAGE is set) but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are missing: players cannot link GitHub, so no PR will score.",
    );
  }

  // Validate at startup rather than during auth-module import: imports also
  // run during `next build`, when event configuration may be absent. Checking
  // per request would be too late because cookie policy has already been set.
  const verdict = checkEventUrl({
    url: process.env.BETTER_AUTH_URL,
    nodeEnv: process.env.NODE_ENV,
    allowInsecure: process.env.ALLOW_INSECURE_EVENT_URL === "1",
  });

  if (verdict.level === "warn") {
    console.warn(`⚠️  ctf-app: ${verdict.message}`);
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation.node");
    await registerNodeInstrumentation();
  }

  // Throwing here stops the server before it serves anything. The Redis
  // compatibility guard has also run, so either startup problem is surfaced.
  if (verdict.level === "fail") {
    throw new Error(`ctf-app: ${verdict.message}`);
  }
}
