import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel, clearDemoData, seedDemoData } from "@/lib/admin-store";

// Populate (POST) or remove (DELETE) demo leaderboard rows. No DEMO_MODE gate
// (issue #419 — dropped everywhere, not just here): admin-gated + type-to-
// confirm is the whole safety net now, same pattern as /api/admin/reset.
// Injects/removes fake scores/teams — never a production operation, but no
// longer impossible to reach on a real event's box either.
export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = (await request.json().catch(() => null)) as { confirm?: string } | null;
  if (body?.confirm !== "SEED") {
    return NextResponse.json({ error: "confirmation phrase does not match" }, { status: 400 });
  }

  try {
    const result = await seedDemoData(gate.login);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[admin/seed] seed failed", adminErrorLabel(err));
    return NextResponse.json({ error: "seed failed" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const body = (await request.json().catch(() => null)) as { confirm?: string } | null;
  if (body?.confirm !== "CLEAR DEMO DATA") {
    return NextResponse.json({ error: "confirmation phrase does not match" }, { status: 400 });
  }

  try {
    const result = await clearDemoData(gate.login);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[admin/seed] clear failed", adminErrorLabel(err));
    return NextResponse.json({ error: "clear failed" }, { status: 503 });
  }
}
