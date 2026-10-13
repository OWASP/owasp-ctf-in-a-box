import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import {
  AdjustmentValidationError,
  addAdjustment,
  listAdjustments,
  removeAdjustment,
} from "@/lib/adjustments-store";

/**
 * Organizer score adjustments (issue #591): a signed points change for a team,
 * with a required reason. Admin-only; the acting admin is the session's, never
 * a body field.
 *
 *   GET                                  the ledger, newest first
 *   POST   {slug, points, reason}        add one
 *   DELETE {id}                          remove one (the removal is audited)
 */

function fail(err: unknown, label: "list" | "add" | "remove") {
  if (err instanceof AdjustmentValidationError) {
    return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
  }
  console.error("[admin/adjustments] %s failed", label, errorLabel(err));
  return NextResponse.json({ error: "unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    return NextResponse.json({ adjustments: await listAdjustments() });
  } catch (err) {
    return fail(err, "list");
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  let body: { slug?: unknown; points?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.slug !== "string" || typeof body.points !== "number" || typeof body.reason !== "string") {
    return NextResponse.json({ error: "slug and reason must be strings, points a number" }, { status: 400 });
  }
  try {
    return NextResponse.json(await addAdjustment(body.slug, body.points, body.reason, gate.login));
  } catch (err) {
    return fail(err, "add");
  }
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  let body: { id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    return NextResponse.json(await removeAdjustment(body.id, gate.login));
  } catch (err) {
    return fail(err, "remove");
  }
}
