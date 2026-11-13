import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { auditActor } from "@/lib/admin-audit-keys";
import { errorLabel } from "@/lib/error-label";
import {
  OpsValidationError,
  deleteUser,
  lookupUser,
  resetUserProgress,
} from "@/lib/admin-ops-store";

/**
 * Per-contestant support operations (issue #168).
 *
 *   GET    ?id=<player id>   look one up — read-only
 *   POST   {id, action:"reset"}   clear their progress
 *   DELETE {id}    remove them entirely
 *
 * Every method is behind `requireAdmin`. GET is gated as hard as the writes
 * are: it returns everything the box knows about one named contestant, which
 * is exactly the read a non-admin must never have.
 *
 * The player id always comes from the caller here (the Support tab's search,
 * GET /api/admin/players), unlike the contestant-facing routes where it comes
 * from the session — that is the whole point of an admin tool. It is
 * validated in the store rather than trusted, because these keys are built by
 * interpolation. The audit actor is the session's admin, by id and name.
 *
 * Reset is a POST with an explicit `action` rather than its own verb on this
 * path, so the destructive operation cannot be reached by a bare POST from a
 * form or a stray fetch that forgot its body.
 */

function fail(err: unknown, label: "lookup" | "reset" | "delete") {
  if (err instanceof OpsValidationError) {
    return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
  }
  // Literal format string, label as an argument. These labels are already
  // literals at every call site, so this is hygiene rather than a fix — but
  // the sink shape is identical to the one CodeQL flagged on the team route,
  // and a `string` parameter is an invitation to pass request data later.
  console.error("[admin/ops/user] %s failed", label, errorLabel(err));
  return NextResponse.json({ error: "unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    return NextResponse.json(await lookupUser(id));
  } catch (err) {
    return fail(err, "lookup");
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let body: { id?: unknown; action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string") {
    return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  }
  if (body.action !== "reset") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  try {
    return NextResponse.json(await resetUserProgress(body.id, auditActor(gate.player)));
  } catch (err) {
    return fail(err, "reset");
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
  if (typeof body.id !== "string") {
    return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  }

  try {
    return NextResponse.json(await deleteUser(body.id, auditActor(gate.player)));
  } catch (err) {
    return fail(err, "delete");
  }
}
