import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, getAdminSettings, resetEvent } from "@/lib/admin-store";
import { resolveSite } from "@/lib/site";
import { auditActor } from "@/lib/admin-audit-keys";

// Master reset: wipe all event data. Admin-gated + type-to-confirm, both
// enforced server-side (never trust the client). The confirm value must match
// the RUNTIME event name (issue #386 — an organizer rename must be reflected
// here, not the name baked at build time) or the literal "RESET".
export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = (await request.json().catch(() => ({}))) as { confirm?: string };

  // Fail CLOSED, deliberately not `getSite()`: that helper's snapshot catches
  // a settings-read error and serves the default name, which would let a
  // Redis blip silently accept the default confirmation on a destructive
  // route. getAdminSettings() throws on a failed HGETALL — refuse before any
  // comparison or resetEvent() when it does.
  let name: string;
  try {
    const settings = await getAdminSettings();
    // Only `.name` is used here — the schedule fields feed `dates`/
    // `ctfStartsAt`, neither read by this route — but resolveSite now
    // requires the argument, so hand it the same settings read rather than
    // `null`, matching every other resolveSite call site in this codebase.
    name = resolveSite(settings.eventIdentity, {
      scoringStartsAt: settings.scoringStartsAt,
      scoringEndsAt: settings.scoringEndsAt,
    }).name;
  } catch (err) {
    console.error("[admin/reset] settings read failed", adminErrorLabel(err));
    return NextResponse.json({ error: "settings read failed" }, { status: 503 });
  }

  if (body.confirm !== name && body.confirm !== "RESET") {
    return NextResponse.json({ error: "confirmation does not match the event name" }, { status: 400 });
  }

  try {
    const result = await resetEvent(auditActor(gate.player));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[admin/reset] reset failed", adminErrorLabel(err));
    return NextResponse.json({ error: "reset failed" }, { status: 503 });
  }
}
