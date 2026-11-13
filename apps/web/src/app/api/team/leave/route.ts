import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { leaveTeam } from "@/lib/team-store";

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = player.id;

  // `confirm: true` is the player accepting the after-close warning;
  // only a literal true counts.
  const body = await request.json().catch(() => ({}));
  const result = await leaveTeam(playerId, { confirmClosed: body?.confirm === true });
  if (!result.ok && result.needsConfirm) {
    return NextResponse.json({ error: result.error, needsConfirm: true }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ team: result.team });
}
