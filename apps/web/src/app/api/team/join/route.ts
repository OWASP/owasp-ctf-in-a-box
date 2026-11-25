import { NextResponse } from "next/server";
import { accountExists } from "@/lib/account-exists";
import { getPlayer } from "@/lib/player";
import { joinTeam } from "@/lib/team-store";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit-store";

export async function POST(request: Request) {
  const player = await getPlayer(request.headers);
  if (!player) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!player.username) return NextResponse.json({ error: "username_required" }, { status: 409 });
  const playerId = player.id;

  const body = await request.json().catch(() => ({}));
  const code = typeof body.code === "string" ? body.code : "";
  if (!code) return NextResponse.json({ error: "Join code is required" }, { status: 400 });

  // Charged AFTER the shape checks and BEFORE joinTeam, so a malformed body
  // costs nothing and no code is ever tested without being charged for.
  const limit = await consumeRateLimit(
    RATE_LIMITS.teamJoin.bucket,
    playerId,
    RATE_LIMITS.teamJoin.limit,
    RATE_LIMITS.teamJoin.windowSeconds,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many join attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // The account check sits right before the write, after the body is read:
  // a deleted player's cached session passes getPlayer, and a slow body
  // must not widen the gap between the check and the write.
  if (!(await accountExists(player.id))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await joinTeam(playerId, code);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ team: result.team });
}
