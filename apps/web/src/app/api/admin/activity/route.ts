import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { listActivity } from "@/lib/activity-log";

/**
 * One page of the activity log (issue #212), newest first.
 *
 *   GET ?offset=<n>&limit=<n>   ->  { entries, total }
 *
 * ADMIN-ONLY, and it stays that way: every entry names a contestant. The
 * entries themselves carry ids only — never flags, answers, or hint text
 * (see activity-log.ts, rule 2) — but "who was signed in when" is still
 * per-person data with no business on a public surface.
 *
 * Filtering (by type, by a search over every field, by time) happens
 * client-side in the Activity tab, which reads the whole list while a filter
 * is on: the list is capped at a few thousand short rows, and a server-side
 * filter would mean a second pagination contract ("offset within the
 * filtered view") for no real saving.
 *
 * Uncached: an organizer refreshing this mid-event wants the current tail.
 */
export const dynamic = "force-dynamic";

/** Page-size ceiling. Big enough that "Load more" is rare on a normal event,
 *  small enough that one response stays comfortably sized. */
const LIMIT_MAX = 500;
const LIMIT_DEFAULT = 200;

/** Clamps an integer query param into [0 | 1, max]; junk falls back. */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) return fallback;
  return Math.min(value, max);
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const params = new URL(request.url).searchParams;
  const offset = intParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(params.get("limit"), LIMIT_DEFAULT, 1, LIMIT_MAX);

  try {
    const page = await listActivity(offset, limit);
    return NextResponse.json(page);
  } catch (err) {
    console.error("[admin/activity] read failed", errorLabel(err));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
