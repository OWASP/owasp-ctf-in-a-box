import { NextResponse } from "next/server";
import { requireAdmin, isEnvAdmin, listEnvAdmins } from "@/lib/admin-auth";
import {
  AdminValidationError,
  addStoredAdmin,
  adminErrorLabel,
  listStoredAdmins,
  removeStoredAdmin,
} from "@/lib/admin-store";
import { auditActor } from "@/lib/admin-audit-keys";

/**
 * Runtime admin management (issue #147). GET lists, POST grants, DELETE
 * revokes. Every method is behind `requireAdmin` — an admin is the only role
 * that can create another one, and there is no self-service path in.
 *
 * ENV ADMINS ARE NOT REVOCABLE HERE. They come from `ADMIN_LOGINS`, they are
 * the recovery path when a runtime grant goes wrong, and refusing to remove
 * them is what makes the panel safe to hand to a co-organizer: no sequence of
 * clicks, and no compromised admin session, can lock everyone out of /admin.
 * Removing one needs an env edit and a restart, deliberately.
 */

function payload(baked: string[], stored: string[]) {
  // `stored` may contain a login that is ALSO an env admin (granted at
  // runtime, then added to ADMIN_LOGINS on the next restart). It is reported
  // once, marked baked, because that is the property that decides whether it
  // can be removed.
  const bakedSet = new Set(baked);
  const rows = [
    ...baked.map((login) => ({ login, baked: true })),
    ...stored.filter((l) => !bakedSet.has(l)).map((login) => ({ login, baked: false })),
  ];
  return { admins: rows };
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    return NextResponse.json(payload(listEnvAdmins(), await listStoredAdmins()));
  } catch (err) {
    console.error("[admin/admins] list failed", adminErrorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let login: unknown;
  try {
    ({ login } = (await request.json()) as { login?: unknown });
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof login !== "string") {
    return NextResponse.json({ error: "login must be a string" }, { status: 400 });
  }

  try {
    const stored = await addStoredAdmin(login, auditActor(gate.player));
    return NextResponse.json(payload(listEnvAdmins(), stored));
  } catch (err) {
    if (err instanceof AdminValidationError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    console.error("[admin/admins] add failed", adminErrorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let login: unknown;
  try {
    ({ login } = (await request.json()) as { login?: unknown });
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof login !== "string") {
    return NextResponse.json({ error: "login must be a string" }, { status: 400 });
  }

  // THE LOCKOUT GUARD. Checked here rather than in the store so the store
  // stays a plain set operation, and so the refusal can say why.
  if (isEnvAdmin(login)) {
    return NextResponse.json(
      {
        error:
          "That admin is set in ADMIN_LOGINS and cannot be removed here — it is the recovery path if a runtime grant goes wrong. Remove it from ADMIN_LOGINS and restart.",
        field: "login",
      },
      { status: 409 },
    );
  }

  // Removing YOURSELF is allowed, and deliberately so: an organizer stepping
  // away should not need someone else to revoke them. It cannot lock the event
  // out, because a baked admin always remains. The UI warns before doing it.
  try {
    const stored = await removeStoredAdmin(login, auditActor(gate.player));
    return NextResponse.json(payload(listEnvAdmins(), stored));
  } catch (err) {
    if (err instanceof AdminValidationError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    console.error("[admin/admins] remove failed", adminErrorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
