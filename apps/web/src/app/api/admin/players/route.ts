import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { findPlayers } from "@/lib/player";

/** Longest search accepted: past this it is not a name anyone typed. */
const QUERY_MAX = 64;

/**
 * GET ?q=<text> — the Support tab's player search. Answers
 * `{ players: [{ id, name, image }] }`: what a row needs to be picked and
 * then acted on by id. The match also covers the GitHub login, but the login
 * itself is not returned.
 *
 * Behind `requireAdmin`, which fails closed: a refused or unreachable gate
 * never reaches the search.
 */
export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (!q || q.length > QUERY_MAX) {
    return NextResponse.json({ error: `q must be 1 to ${QUERY_MAX} characters` }, { status: 400 });
  }
  try {
    const players = await findPlayers(q);
    return NextResponse.json({ players: players.map(({ id, name, image }) => ({ id, name, image })) });
  } catch (err) {
    console.error("[admin/players] search failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
