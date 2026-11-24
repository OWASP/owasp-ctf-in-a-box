import { behindCloudflare, trustedClientIpHeader } from "@/lib/client-ip";
import { configuredProviders } from "@/lib/sign-in-providers";
import { checkEventUrl } from "@/lib/secure-url";
import { errorLabel } from "@/lib/error-label";

/** Starts the Discord announcer only in the Node.js runtime, without
 *  blocking application startup. Redis compatibility must be checked first.
 */
async function startDiscordAnnouncer(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { startAnnounceTicker } = await import("@/lib/announce/ticker");
    startAnnounceTicker();
  } catch (err) {
    console.error("ctf-app: discord announcer not started:", errorLabel(err));
  }
}

/**
 * Next's server-startup hook: called once per server instance, and completes
 * before the first request is served.
 *
 * The Edge runtime loads this file too, so Node-only Redis compatibility
 * checks and the Discord announcer are dynamically imported only in Node.js.
 */
export async function register(): Promise<void> {
  trustedClientIpHeader();
  behindCloudflare();

  if ((process.env.SCORE_IMAGE ?? "").trim() !== "" && !configuredProviders().includes("github")) {
    console.error(
      "[startup] Secure Development is on (SCORE_IMAGE is set) but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are missing: players cannot link GitHub, so no PR will score.",
    );
  }

  const verdict = checkEventUrl({
    url: process.env.BETTER_AUTH_URL,
    nodeEnv: process.env.NODE_ENV,
    allowInsecure: process.env.ALLOW_INSECURE_EVENT_URL === "1",
  });

  if (verdict.level === "warn") {
    console.warn(`⚠️  ctf-app: ${verdict.message}`);
  }

  // Mandatory compatibility check: failure prevents normal startup.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation.node");
    await registerNodeInstrumentation();
  }

  if (verdict.level === "fail") {
    throw new Error(`ctf-app: ${verdict.message}`);
  }

  // Optional background service: never blocks application serving.
  startDiscordAnnouncer();
}
