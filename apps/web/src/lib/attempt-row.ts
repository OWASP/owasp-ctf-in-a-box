/**
 * The attempt-row shape, and the ONE parser for it.
 *
 * Quiz and classic each keep a per-login attempts hash (`ctf:quiz:attempts:<login>`,
 * `ctf:classic:attempts:<login>`) whose field is the item id and whose VALUE is
 * a JSON object written by their respective Lua scripts:
 *
 *     {"attempts":2,"firstAt":"<iso>","lastAt":"<iso>","lastAtMs":1234567890}
 *
 * That it is JSON — and not a bare count — is the whole reason this file
 * exists. The admin support tab summed these rows with `Number(value)`, which
 * on a JSON string is `NaN`, so its "Attempts" figure read **0 for every
 * contestant, always**. Nothing caught it: before the demo seed wrote attempt
 * rows at all, zero was the correct answer for seeded data, so the bug and the
 * empty fixture agreed with each other.
 *
 * Two readers now share this parser (metrics-store's per-challenge fold and
 * admin-ops-store's per-contestant lookup) precisely so a third cannot
 * reinvent `Number(value)` and be wrong in the same silent way.
 */

type AttemptRow = {
  /** Tries recorded for this item. 0 when the row is absent or unreadable. */
  attempts: number;
  /** When they FIRST tried it. Null on rows written before the field existed,
   *  so every consumer must tolerate null rather than assume a date. */
  firstAt: string | null;
};

const EMPTY: AttemptRow = { attempts: 0, firstAt: null };

/** Parses one attempt row. Unreadable rows read as "no attempts" rather than
 *  throwing: a corrupt row must not take down a whole leaderboard fold or a
 *  support lookup an organizer is running mid-event. */
export function parseAttemptRow(raw: unknown): AttemptRow {
  if (typeof raw !== "string") return EMPTY;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      attempts: typeof v.attempts === "number" ? v.attempts : 0,
      firstAt: typeof v.firstAt === "string" && v.firstAt ? v.firstAt : null,
    };
  } catch {
    return EMPTY;
  }
}

/** Total tries across every row of one HGETALL reply (Upstash returns a flat
 *  [field, value, field, value, ...] array). */
export function sumAttempts(hgetallResult: unknown): number {
  if (!Array.isArray(hgetallResult)) return 0;
  let total = 0;
  for (let i = 1; i < hgetallResult.length; i += 2) {
    total += parseAttemptRow(hgetallResult[i]).attempts;
  }
  return total;
}
