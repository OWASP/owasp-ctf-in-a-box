import { NextResponse } from "next/server";
import { accountExists } from "@/lib/account-exists";
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

  // The account check sits right before the write, after the body is read:
  // a deleted player's cached session passes getPlayer, and a slow body
  // must not widen the gap between the check and the write.
  if (!(await accountExists(player.id))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await renameTeam(playerId, slug, name);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusForError(result.error) });
  return NextResponse.json({ team: result.team });
}
