import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { issueAdminCode, NotAdminError } from "@/lib/admin-claim";
import { adminErrorLabel } from "@/lib/admin-store";
import { auditActor } from "@/lib/admin-audit-keys";

/**
 * Issue a single-use admin claim code that expires in 15 minutes (ADR 73).
 * The response is the ONE place the code exists outside the issuing admin's
 * screen: only its hash is stored, it is never logged, and the answer is
 * `no-store` so no cache keeps it.
 */
export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    const issued = await issueAdminCode(auditActor(gate.player));
    return NextResponse.json(issued, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // Revoked between the gate above and the script: the same answer the gate gives.
    if (err instanceof NotAdminError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    console.error("[admin/codes] issue failed", adminErrorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
