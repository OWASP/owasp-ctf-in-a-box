import { NextResponse } from "next/server";
import { accountExists } from "@/lib/account-exists";
import { getPlayer } from "@/lib/player";
import { leaveTeam } from "@/lib/team-store";

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = player.id;

  // `confirm: true` is the player accepting the after-close warning;
  // only a literal true counts.
  const body = await request.json().catch(() => ({}));
  // The account check sits right before the write, after the body is read:
  // a deleted player's cached session passes getPlayer, and a slow body
  // must not widen the gap between the check and the write.
  if (!(await accountExists(player.id))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await leaveTeam(playerId, { confirmClosed: body?.confirm === true });
  if (!result.ok && result.needsConfirm) {
    return NextResponse.json({ error: result.error, needsConfirm: true }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ team: result.team });
}
