import "server-only";
import { assertPipelineOk, upstashPipeline } from "@/lib/upstash";

/**
 * Guarded writes for an organizer-managed category list (classic's and ai's),
 * shared by both stores because the race they close is the same one.
 *
 * Upstash's `/pipeline` is not transactional, so "read the list, decide, write
 * the list back" in two round trips lets a second organizer's edit land in
 * between and be overwritten without a word to either of them. Each write here
 * is therefore a compare-and-set: the store reads the list and decides IN JS,
 * then hands Redis one script that writes only if the list is still byte for
 * byte the value that was read, and otherwise writes NOTHING and says so.
 *
 * Why the decision stays in JS rather than moving into the script: it folds
 * case (`toLowerCase`) to dedupe and to detect a rename collision, and Lua's
 * `string.lower` is ASCII-only — a Lua fold would disagree with the panel's own
 * check on any non-ASCII name. The script compares raw values only.
 *
 * What a refused write turns into differs by operation:
 *
 *   - A whole-list replace (`writeCategoriesIfUnchanged`) carries the list the
 *     organizer EDITED FROM. If the stored list is not that one, the
 *     organizer's intent was formed against a list that no longer exists, and
 *     only they can say what the merge should be — so it is refused with
 *     `CategoryConflictError` (the routes answer 409) rather than rebased.
 *   - A rename (`renameCategoryAtomically`) is an operation, not a snapshot:
 *     "this category is now called that" means the same thing against the
 *     fresh list. A refused attempt is re-read and re-planned, and only a
 *     rename that keeps losing the race gives up with the same conflict.
 */

/** How many guarded writes one request tries before giving up with a
 *  conflict. Losing even once needs two organizers inside the same few
 *  milliseconds; losing this many times in a row means the list is being
 *  hammered and the organizer should look at it before trying again. */
export const CATEGORY_WRITE_ATTEMPTS = 3;

export const CATEGORY_CONFLICT_MESSAGE =
  "The category list changed since you loaded it — someone else may be editing it. Reload and try again.";

/** A guarded category write was refused because the stored list moved on.
 *  Nothing was written. The routes answer 409 with the message. */
export class CategoryConflictError extends Error {
  constructor() {
    super(CATEGORY_CONFLICT_MESSAGE);
    this.name = "CategoryConflictError";
  }
}

// The guard both scripts open with. ARGV[1] says whether the key existed when
// it was read ("1") or not ("0"), and ARGV[2] is the value read. An absent key
// is its own state, not "the empty string": a list created in the meantime has
// to refuse the write as surely as one that changed. GET errors on a key of the
// wrong type, which ends the script before anything is written.
const GUARD_LUA = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return 0 end
elseif current then
  return 0
end
`;

/** KEYS[1] the list; ARGV[1..2] the guard; ARGV[3] the list to store, as the
 *  JSON the caller built. Returns 1 when written, 0 when refused. */
export const SET_CATEGORIES_SCRIPT = `${GUARD_LUA}
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

/**
 * KEYS[1] the list, KEYS[2] the challenge hash. ARGV[1..2] the list guard,
 * ARGV[3] the renamed list, ARGV[4] the category's STORED spelling, then one
 * triple per challenge the caller found in it: id, the record exactly as read,
 * the record to write.
 *
 * Refuses (0, nothing written) unless the list is unchanged, every planned
 * record is still exactly as read, and no record outside the plan names the
 * category — one filed into it after the read would otherwise be left under a
 * name the list no longer holds, invisible to the board's exact-match filter.
 *
 * Every read that can fail runs before the first write. Redis does not roll
 * back a script's earlier writes when a later command errors, so a failure
 * after the challenge writes would leave them moved under a list that still
 * names the old category. HSET and SET against keys this script just read as
 * the right type do not fail that way.
 *
 * The records to write are built by the caller with `JSON.stringify`, not
 * re-encoded here: cjson would rewrite every number past 14 significant digits
 * and escape every `/`, changing records the rename has no business touching.
 * cjson only DECODES here, to spot an unplanned record in the category.
 */
export const RENAME_CATEGORY_SCRIPT = `${GUARD_LUA}
local plan = {}
local planned = 0
for i = 5, #ARGV, 3 do
  plan[ARGV[i]] = i
  planned = planned + 1
end

local flat = redis.call('HGETALL', KEYS[2])
local found = 0
for i = 1, #flat, 2 do
  local at = plan[flat[i]]
  if at then
    if flat[i + 1] ~= ARGV[at + 1] then return 0 end
    found = found + 1
  else
    local ok, record = pcall(cjson.decode, flat[i + 1])
    if ok and type(record) == 'table' and record['category'] == ARGV[4] then return 0 end
  end
end
if found ~= planned then return 0 end

for i = 5, #ARGV, 3 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 2])
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

/** Parses the stored list exactly as both stores' `list*Categories` read it:
 *  absent or unparseable is an empty list, and non-string entries are
 *  dropped. The conflict check compares the organizer's view against THIS, so
 *  it has to be the view the panel was given. */
export function parseCategoryList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** The guard ARGV for a GET reply: whether the key existed, and its value. */
function guardOf(raw: unknown): [string, string] {
  return typeof raw === "string" ? ["1", raw] : ["0", ""];
}

/** Stores `next` only if the stored list is still `expected` — the list the
 *  organizer was looking at when they made the edit. Throws
 *  `CategoryConflictError` (nothing written) when it is not, and a plain
 *  `Error` when Redis fails. */
export async function writeCategoriesIfUnchanged(
  key: string,
  expected: readonly string[],
  next: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < CATEGORY_WRITE_ATTEMPTS; attempt++) {
    const [read] = assertPipelineOk(await upstashPipeline([["GET", key]]), "category list read");
    if (!sameList(parseCategoryList(read.result), expected)) throw new CategoryConflictError();
    const [present, raw] = guardOf(read.result);
    const [written] = assertPipelineOk(
      await upstashPipeline([["EVAL", SET_CATEGORIES_SCRIPT, 1, key, present, raw, JSON.stringify(next)]]),
      "category list write",
    );
    // Refused: the value changed between the read and the script. Loop to
    // re-read — a list rewritten to the same names still matches `expected`.
    if (written.result === 1) return;
  }
  throw new CategoryConflictError();
}

export type RenameOutcome =
  | { kind: "missing" }
  | { kind: "collides" }
  | { kind: "renamed"; categories: string[]; moved: number };

/** Every challenge record filed under `stored`, as id/raw pairs. Matches on
 *  the parsed `category` alone, the same test the script applies to a record
 *  outside the plan — a narrower match here (say, only records that parse as
 *  a full challenge) would leave a record the script counts as "in the
 *  category but unplanned", and every attempt would be refused. */
function recordsIn(flat: unknown, stored: string): { id: string; raw: string; record: Record<string, unknown> }[] {
  const arr = Array.isArray(flat) ? flat : [];
  const out: { id: string; raw: string; record: Record<string, unknown> }[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const id = arr[i];
    const raw = arr[i + 1];
    if (typeof id !== "string" || typeof raw !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.category === stored) out.push({ id, raw, record });
  }
  return out;
}

/**
 * Renames one category to `target` and moves every challenge filed under it,
 * in one script. `from` is matched case-insensitively against the list; the
 * challenges are matched on the list's STORED spelling, which is the one they
 * carry (an upsert refuses any other).
 *
 * `missing` and `collides` are answers about the list as it stands when the
 * rename finally runs, so a rename racing another rename of the same category
 * reports `missing` rather than applying twice. `target` must already be
 * trimmed and validated by the caller.
 */
export async function renameCategoryAtomically(
  keys: { categories: string; challenges: string },
  from: string,
  target: string,
): Promise<RenameOutcome> {
  const fromFold = from.trim().toLowerCase();
  const targetFold = target.toLowerCase();
  for (let attempt = 0; attempt < CATEGORY_WRITE_ATTEMPTS; attempt++) {
    // Read in one round trip, and fail on either reply's error: a failed
    // HGETALL read as an empty hash would look like "nothing uses this
    // category" and plan a rename that moves nothing.
    const [listRes, hashRes] = assertPipelineOk(
      await upstashPipeline([
        ["GET", keys.categories],
        ["HGETALL", keys.challenges],
      ]),
      "category rename read",
    );
    const categories = parseCategoryList(listRes.result);
    const index = categories.findIndex((name) => name.toLowerCase() === fromFold);
    if (index === -1) return { kind: "missing" };
    if (categories.some((name, i) => i !== index && name.toLowerCase() === targetFold)) return { kind: "collides" };

    const stored = categories[index];
    const moving = recordsIn(hashRes.result, stored);
    const next = [...categories];
    next[index] = target;
    const plan = moving.flatMap(({ id, raw, record }) => [id, raw, JSON.stringify({ ...record, category: target })]);
    const [present, raw] = guardOf(listRes.result);

    const [written] = assertPipelineOk(
      await upstashPipeline([
        [
          "EVAL",
          RENAME_CATEGORY_SCRIPT,
          2,
          keys.categories,
          keys.challenges,
          present,
          raw,
          JSON.stringify(next),
          stored,
          ...plan,
        ],
      ]),
      "category rename write",
    );
    if (written.result === 1) return { kind: "renamed", categories: next, moved: moving.length };
  }
  throw new CategoryConflictError();
}
