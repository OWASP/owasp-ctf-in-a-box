import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { renameTeam } from "@/lib/team-store";

function statusForError(error: string): number {
  if (error.toLowerCase().includes("captain")) return 403;
  if (error.toLowerCase().includes("demo mode")) return 409;
  return 400;
}

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = player.id;

  const body = await request.json().catch(() => ({}));
  const slug = typeof body.slug === "string" ? body.slug : "";
  const name = typeof body.name === "string" ? body.name : "";

  const result = await renameTeam(playerId, slug, name);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusForError(result.error) });
  return NextResponse.json({ team: result.team });
}
