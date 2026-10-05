/**
 * The ONE decoder for Upstash's flat Redis replies — and the ONE attempt-row
 * READ for the Lua grading scripts (#504 M13).
 *
 * quiz, classic and ai all decode the same three shapes — `parseJsonValue`,
 * `parseHashEntries` and `parseCounterHash` — and a parser kept per store is
 * three places for the next one to drift: the row-shape contract
 * (`attempt-row.ts`'s header tells the same story from the reader side) only
 * holds while every store decodes the same way.
 *
 * The reply shapes these read:
 *
 *   * HGETALL → a FLAT `[field, value, field, value, …]` array (never an
 *     object) — that is what `parseHashEntries` and `parseCounterHash` walk.
 *   * HGET → a bare string, or nil — `parseJsonValue`.
 *
 * Failure direction, deliberately: a row that is not JSON, not an object, or
 * whose `extract` rejects the shape is SKIPPED (or reads as null), never
 * thrown. One corrupt hash row must not take down a whole leaderboard fold or
 * a viewer's progress page.
 */

/** Parses a single HGET reply (not a flat hash array) the same way
 *  `parseHashEntries` parses each row of one. */
export function parseJsonValue<T>(raw: unknown, extract: (parsed: Record<string, unknown>) => T | null): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return extract(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Parses one HGETALL reply into `{ field: T }`, keeping only the rows whose
 *  value is JSON, is an object, and survives `extract`. */
export function parseHashEntries<T>(flat: unknown, extract: (parsed: Record<string, unknown>) => T | null): Record<string, T> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out: Record<string, T> = {};
  for (let i = 0; i < arr.length; i += 2) {
    const value = parseJsonValue(arr[i + 1], extract);
    if (value !== null) out[arr[i]] = value;
  }
  return out;
}

/** Parses one HGETALL reply of numeric fields (the aggregate points/solved/
 *  answered/solvecount hashes) into a Map. Non-numeric values are dropped, so
 *  a corrupt counter reads as absent rather than as `NaN` propagating into a
 *  total. */
export function parseCounterHash(flat: unknown): Map<string, number> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out = new Map<string, number>();
  for (let i = 0; i < arr.length; i += 2) {
    const n = Number(arr[i + 1]);
    if (Number.isFinite(n)) out.set(arr[i], n);
  }
  return out;
}

/**
 * The attempt-row READ — `attempts`, `lastAtMs` and `firstAt` out of the JSON
 * row quiz's, classic's and ai's grading scripts share
 * (`{"attempts":2,"firstAt":"…","lastAt":"…","lastAtMs":123} — see
 * `attempt-row.ts` for the shape and the TS-side reader).
 *
 * Quiz's `GRADE_SCRIPT`, classic's `SUBMIT_SCRIPT` and ai's `AWARD_SCRIPT`
 * all read exactly this, then rewrite the row with `attempts + 1`. Three
 * hand-copied blocks is three places for the cooldown or the attempt budget to
 * start reading a field the others still write: Redis runs the copy in the
 * calling script, so a divergence is silent (one module's cap checks a
 * different number than its neighbour's) and only shows up as a bug in one
 * module.
 *
 * Deliberately a regex read, not `cjson.decode`: these scripts only need three
 * scalars, and decoding the whole row would turn a malformed row from "reads
 * as 0 attempts" into a script error that REFUSES a legitimate submission.
 *
 * Spelling and field names are the contract with the write in each script
 * (`'{"attempts":' … '"firstAt":"' … '"lastAtMs":' …`); change one, change
 * both. Indentation is intentionally none: the same block is pasted at
 * top level (quiz, classic) and one level in (ai), and Lua does not care.
 *
 * Interpolated into each script with `${ATTEMPT_ROW_LUA}`, so a change lands
 * in all three at once.
 */
export const ATTEMPT_ROW_LUA = `local attemptsRaw = redis.call('HGET', KEYS[1], ARGV[1])
local attempts = 0
local lastAtMs = nil
local firstAt = nil
if attemptsRaw then
  local foundAttempts = string.match(attemptsRaw, '"attempts":(%d+)[,}]')
  if foundAttempts then attempts = tonumber(foundAttempts) end
  local foundLastAtMs = string.match(attemptsRaw, '"lastAtMs":(%d+)[,}]')
  if foundLastAtMs then lastAtMs = tonumber(foundLastAtMs) end
  -- Carried forward, never recomputed: this row is REWRITTEN on every
  -- submission, so the first attempt's time survives only by being read back
  -- out of the row it is being replaced by. Absent on rows written before
  -- this field existed, which is why the write below falls back to now.
  firstAt = string.match(attemptsRaw, '"firstAt":"([^"]*)"')
end`;
