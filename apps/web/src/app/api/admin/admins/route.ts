import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listAdminGrants } from "@/lib/admin-grants";
import { revokeAdmin } from "@/lib/admin-claim";
import { LAST_ADMIN } from "@/lib/admin-claim-copy";
import { adminErrorLabel } from "@/lib/admin-store";
import { auditActor } from "@/lib/admin-audit-keys";
import { getPlayerProfiles, PLAYER_ID_RE } from "@/lib/player";

/**
 * The admin roster (ADR 73). GET lists it, DELETE revokes one grant. Every
 * method is behind `requireAdmin`. There is no grant here: the only way in is
 * a claim code (POST /api/admin/codes issues one, /admin/claim spends it).
 *
 * The revoke script refuses the LAST grant, so no sequence of clicks leaves
 * the box with nobody who can open /admin. Removing yourself is allowed while
 * another admin remains; the tab confirms first.
 */

const DELETED = "(deleted account)";

type AdminRow = { id: string; name: string; self: boolean };

async function rows(ids: string[], viewerId: string): Promise<AdminRow[]> {
  const profiles = await getPlayerProfiles(ids);
  return ids.map((id) => ({ id, name: profiles.get(id)?.name ?? DELETED, self: id === viewerId }));
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    return NextResponse.json({ admins: await rows(await listAdminGrants(), gate.player.id) });
  } catch (err) {
    console.error("[admin/admins] list failed", adminErrorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  let id: unknown;
  try {
    ({ id } = (await request.json()) as { id?: unknown });
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof id !== "string" || !PLAYER_ID_RE.test(id)) {
    return NextResponse.json({ error: "id must be a player id", field: "id" }, { status: 400 });
  }

  try {
    const name = (await getPlayerProfiles([id])).get(id)?.name ?? DELETED;
    const result = await revokeAdmin({ id, name }, auditActor(gate.player));
    if (!result.ok) {
      if (result.reason === "last-admin") return NextResponse.json({ error: LAST_ADMIN }, { status: 409 });
      return NextResponse.json({ error: "not an admin" }, { status: 404 });
    }
    return NextResponse.json({ admins: await rows(result.grants, gate.player.id) });
  } catch (err) {
    console.error("[admin/admins] remove failed", adminErrorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
