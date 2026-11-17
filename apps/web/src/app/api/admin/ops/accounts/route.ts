import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { auditActor } from "@/lib/admin-audit-keys";
import { errorLabel } from "@/lib/error-label";
import { OpsValidationError, deleteAllAccounts } from "@/lib/admin-ops-store";

/**
 * DELETE {confirm} — delete every account, the acting admin's included.
 *
 * Admin-gated here and type-to-confirm checked in the store (the phrase is
 * exact and case-sensitive). The grants go with the accounts, so the caller's
 * own next /admin request is a 403 until someone claims the panel again with
 * a fresh claim code.
 */
export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let body: { confirm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.confirm !== "string") {
    return NextResponse.json({ error: "confirm must be a string" }, { status: 400 });
  }

  try {
    return NextResponse.json(await deleteAllAccounts(body.confirm, auditActor(gate.player)));
  } catch (err) {
    if (err instanceof OpsValidationError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    console.error("[admin/ops/accounts] delete failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
