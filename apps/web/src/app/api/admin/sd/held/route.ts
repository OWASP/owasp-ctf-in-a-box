import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { listHeldScores } from "@/lib/sd-held";

/**
 * Secure Development scores held for authors with no linked account, and the
 * ones no link can still release. ADMIN-ONLY and read-only: it names PR
 * authors, and nothing here writes (no other verb is exported).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  try {
    return NextResponse.json({ entries: await listHeldScores() });
  } catch (err) {
    console.error("[admin/sd/held] read failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
