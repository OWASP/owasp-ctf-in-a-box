// The union-by-item team fold, shared by every module that banks per-login
// "I earned this item, for these points, at this time" rows.
//
// Deliberately NOT server-only and deliberately dependency-free: it is pure
// logic over Upstash pipeline replies, so both stores (`quiz-store.ts`,
// `classic-store.ts`) can delegate to it and its tests can import it directly.

/** One team's folded total. Callers rename `completed` to their own module's
 *  noun (`answered` for quiz, `solved` for classic) — the SHAPE is shared, the
 *  vocabulary is not. */
export type FoldedTotal = {
  points: number;
  completed: number;
  lastAt: string | null;
  /** The deduped set's item ids — what lets a caller union them with a live
   *  catalogue instead of guessing a denominator from a count. */
  itemIds: string[];
  /** Per-item points for the deduped set (earliest solve's points). The
   *  story-lock reachable denominator reads them for a solved-but-deleted
   *  step, whose catalogue entry — and therefore points — no longer exists. */
  itemPoints: Record<string, number>;
};

/** The earned-item record every module stores as the JSON value of its
 *  per-login hash: `{ points, at }`. Extra fields are ignored, and anything
 *  that isn't an object with those two typed fields is skipped. */
type Earned = { points: number; at: string };

/** Parses one hash VALUE. Returns null (rather than throwing) for a
 *  non-string, unparseable, or wrong-shaped row — a single corrupt record must
 *  never take down a whole team's total. Mirrors `parseJsonValue` +
 *  `extractAnswered`/`extractSolve` in the two stores exactly. */
function parseEarned(raw: unknown): Earned | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.points !== "number" || typeof v.at !== "string") return null;
  return { points: v.points, at: v.at };
}

/**
 * Folds one team's members' `HGETALL` replies into a single total, taking the
 * UNION of the items they hold — never the sum of their per-login aggregates.
 *
 * A team's total is the union because summing would double count any item two
 * teammates both earned, which is exactly the double-count bug the per-login
 * aggregate counters exist to avoid at the individual level. The aggregates
 * cannot serve a team either way: they are running totals with no memory of
 * WHICH items contributed to them, so there is nothing in them to dedupe by.
 *
 * The dedupe key is the hash FIELD name — the question id for quiz, the
 * challenge id for classic — and the record kept for a key more than one
 * member holds is the EARLIEST one. That earliest-wins rule is what makes a
 * team's banked score stable: a later solve/answer by a teammate, or a
 * since-changed item price recorded on someone else's row, must never change
 * what the team already earned.
 *
 * `points` is the sum over the deduped set, `completed` its size, and `lastAt`
 * the LATEST timestamp in it (most recent activity, for the "last activity"
 * column) — not the earliest one the dedupe keeps. Rows that fail to parse are
 * skipped, so one corrupt record costs its own item and nothing else.
 *
 * `itemIds` is that deduped set's KEYS, and it is the reason a team row can
 * show the same denominator the profile does. A count alone cannot: the
 * denominator has to be the live catalogue UNIONED with the items a team
 * solved whose challenge an organizer has since deleted, and that needs
 * identity, not a total (issues #330, #343, #348). The ids are already in
 * hand here — the dedupe is built on them — so carrying them out costs
 * nothing beyond the array.
 *
 * `memberReplies` is positional: entry `i` is member `i`'s reply, and an
 * `undefined` entry (a login the caller had no reply for) folds as empty.
 */
export function foldTeamItems(
  memberReplies: ({ result?: unknown; error?: string } | undefined)[],
): FoldedTotal {
  const byItem = new Map<string, Earned>();
  for (const res of memberReplies) {
    const flat = Array.isArray(res?.result) ? (res.result as string[]) : [];
    for (let i = 0; i < flat.length; i += 2) {
      const parsed = parseEarned(flat[i + 1]);
      if (!parsed) continue;
      const itemId = flat[i];
      const existing = byItem.get(itemId);
      if (!existing || Date.parse(parsed.at) < Date.parse(existing.at)) {
        byItem.set(itemId, parsed);
      }
    }
  }

  let points = 0;
  let lastAtMs = -Infinity;
  const itemPoints: Record<string, number> = {};
  for (const [itemId, { points: itemPointsValue, at }] of byItem.entries()) {
    points += itemPointsValue;
    itemPoints[itemId] = itemPointsValue;
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && ms > lastAtMs) lastAtMs = ms;
  }
  return {
    points,
    completed: byItem.size,
    lastAt: Number.isFinite(lastAtMs) ? new Date(lastAtMs).toISOString() : null,
    itemIds: [...byItem.keys()],
    itemPoints,
  };
}
