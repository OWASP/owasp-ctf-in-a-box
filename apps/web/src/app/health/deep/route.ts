import { NextResponse } from "next/server";
import { probeDeepHealth } from "@/lib/health-deep";
import { errorLabel } from "@/lib/error-label";

/**
 * `GET /health/deep` — can this box score right now? (issue #437)
 *
 * The dependency-aware sibling of `/health`, for a different audience.
 * `/health` is what Fly's machine check watches and must never depend on
 * anything the machine does not own; THIS is what an external monitor
 * watches, and it answers 503 the moment Redis or the scorer is unreachable —
 * the failure every fail-open read in this kit hides from contestants.
 *
 * Public and unauthenticated for the same reason `/health` is (a free uptime
 * tier cannot present a credential), and under the same disclosure rule:
 * each dependency is "ok" or "down", nothing more. See lib/health-deep.ts for
 * what is probed, why the poller is reported rather than failed on, and the
 * 10 s cache that bounds what an unauthenticated URL can cost.
 */

// Never prerendered, never cached by Next: a cached "ok" is the one answer a
// health check must not give. (The probe's own 10 s cache is deliberate and
// lives where it can be reasoned about, in lib/health-deep.ts.)
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET() {
  try {
    const health = await probeDeepHealth();
    return NextResponse.json(health, { status: health.status === "ok" ? 200 : 503, headers: NO_STORE });
  } catch (err) {
    // The probe swallows every dependency failure itself; this is the floor
    // if it ever throws anyway. A monitor needs a 503 it can parse, not a
    // framework error page — and, per the disclosure rule, no reason.
    console.error("[health/deep] probe threw:", errorLabel(err));
    return NextResponse.json({ status: "degraded" }, { status: 503, headers: NO_STORE });
  }
}
