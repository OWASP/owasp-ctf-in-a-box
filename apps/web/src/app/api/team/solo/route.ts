import { NextResponse } from "next/server";
import { getPlayer } from "@/lib/player";
import { createSoloTeam } from "@/lib/team-store";

/**
 * Creates a team of one, named after the caller (issue #153).
 *
 * Its own route rather than a flag on POST /api/team because the team NAME is
 * derived server-side from the player's display name and is not an input. A `solo:
 * true` field on the create route would have to ignore any `name` the body
 * carried, and a body field that is silently ignored is a body field somebody
 * eventually relies on.
 *
 * There is nothing to read from the request at all — which is the point: the
 * name comes from the session, so a caller cannot use this to mint a team
 * named after somebody else.
 */
export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playerId = player.id;

  const result = await createSoloTeam(playerId, player.name);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ team: result.team });
}
