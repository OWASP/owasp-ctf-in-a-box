import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { removeMember } from "@/lib/team-store";

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
  const member = typeof body.member === "string" ? body.member : "";

  // `confirm: true` is the captain accepting the after-close warning;
  // only a literal true counts.
  const result = await removeMember(playerId, slug, member, { confirmClosed: body.confirm === true });
  if (!result.ok && result.needsConfirm) {
    return NextResponse.json({ error: result.error, needsConfirm: true }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusForError(result.error) });
  return NextResponse.json({ team: result.team });
}
