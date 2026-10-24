import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { errorLabel } from "@/lib/error-label";
import { requireLaunchedApi } from "@/lib/launch";
import { listRecentSolves } from "@/lib/recent-solves";
import { RECENT_SOLVES_LIMIT } from "@/lib/recent-solves-keys";

/**
 * The projector board's public recent-solves feed (#542).
 *
 * Public and read-only like the leaderboard it decorates, and launch-locked
 * for the same reason: a line names module content, so before launch it is
 * `403 not-launched` to everyone but an admin preview. The response is built
 * by `listRecentSolves` field by field — team name from solve time, a title
 * from the current public lister, points and time. It has no field for a
 * login, challenge id, app id, team slug, flag, hint or activity-log entry,
 * and a now-hidden item (module off, target disabled, challenge deleted,
 * classic story step locked to an anonymous viewer) is dropped rather than
 * redacted.
 */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const login = (session?.user as { login?: string } | undefined)?.login;
  const refused = await requireLaunchedApi(login);
  if (refused) return refused;

  try {
    const solves = await listRecentSolves(RECENT_SOLVES_LIMIT);
    return NextResponse.json({ solves }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[recent-solves] read failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
