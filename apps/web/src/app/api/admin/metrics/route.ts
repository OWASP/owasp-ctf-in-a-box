import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { challengesToCsv, computeEventMetrics } from "@/lib/metrics-store";

/**
 * Event engagement metrics (issue #169).
 *
 *   GET               JSON
 *   GET ?format=csv   the per-challenge table, for a spreadsheet
 *
 * ADMIN-ONLY, and it stays that way. The aggregates themselves are harmless —
 * a per-challenge solve rate is fine to publish — but this payload is computed
 * from per-contestant rows, and every future field added to it is one edit away
 * from carrying a login. Gating the endpoint means that edit cannot become a
 * disclosure by accident. A public post-event summary, if one is ever wanted,
 * should be an explicit export of chosen aggregates, not this route with its
 * guard removed.
 *
 * Nothing here is fetched from a fork, and this route is unrelated to
 * `/api/public/scoring` — that one is read-only, policy-only, and fork-facing
 * (ADR 46). Metrics neither reads from it nor adds a write counterpart, because
 * the only credential a fork can hold is one every contestant can read, which
 * would make contestant-reported engagement numbers forgeable by contestants.
 *
 * Uncached: an organizer refreshing this mid-event wants the current number,
 * and the request rate is one per click.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  try {
    const metrics = await computeEventMetrics();
    if (new URL(request.url).searchParams.get("format") === "csv") {
      return new NextResponse(challengesToCsv(metrics), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          // Named for the event date so a folder of these stays sortable.
          "Content-Disposition": `attachment; filename="challenges-${metrics.generatedAt.slice(0, 10)}.csv"`,
        },
      });
    }
    return NextResponse.json(metrics);
  } catch (err) {
    console.error("[admin/metrics] compute failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
