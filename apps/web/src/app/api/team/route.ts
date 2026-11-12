import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { createTeam } from "@/lib/team-store";

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = player.id;

  const body = await request.json().catch(() => ({}));
  const result = await createTeam(playerId, typeof body.name === "string" ? body.name : "");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ team: result.team });
}
