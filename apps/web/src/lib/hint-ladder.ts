// Client-safe helpers for ordered, independently priced Jeopardy hints.
// Deliberately dependency-free: the admin editor, the bundle parser,
// the contestant page and the server store all need the SAME spelling of a
// hint field and a purchase key, and a second implementation is how two
// readers drift apart.

import { HINT_COST } from "@/lib/hint-defaults";

/** A stored, ordered hint ladder entry. `cost` null means "use the event-wide
 *  hintCost" — absent and null are deliberately the same thing. */
export type HintLevelConfig = {
  text: string;
  cost: number | null;
};

/** Hard cap on one challenge's ladder. Ten is enough to guide a challenge in
 *  steps without turning the page into the answer, and it keeps an admin
 *  payload or bundle from writing an unbounded number of hash fields. */
export const HINT_LEVELS_MAX = 10;

/** The field a level's text (and explicit cost) uses inside the classic hint
 *  hashes. Level 1 keeps the BARE challenge id — the single-hint shape — so
 *  every hint written before ladders existed is automatically level 1, and
 *  so is its purchase record and timestamp. */
export function hintField(id: string, level: number): string {
  return level <= 1 ? id : `${id}#${level}`;
}

/** Inverse of `hintField`, for availability reads and purchase-set members.
 *  Returns null for anything that is not a valid level, so a corrupt field
 *  cannot become "level 1 of a bogus id". */
export function parseHintField(field: string): { id: string; level: number } | null {
  if (!field) return null;
  const hash = field.lastIndexOf("#");
  if (hash === -1) return { id: field, level: 1 };
  const id = field.slice(0, hash);
  const raw = field.slice(hash + 1);
  if (!id || !/^[1-9]\d*$/.test(raw)) return null;
  const level = Number(raw);
  return level >= 2 && level <= HINT_LEVELS_MAX ? { id, level } : null;
}

/** A user's purchase record: the same shape the single-hint store already
 *  holds (`<target>/<id>`), with `<target>/<id>#<n>` for later rungs. The
 *  base key stays bare for level 1 so old records and old timestamps read as
 *  hint 1. */
export function hintPurchaseKey(target: string, id: string, level: number): string {
  return level <= 1 ? `${target}/${id}` : `${target}/${id}#${level}`;
}

export function parseHintPurchaseKey(member: string): { target: string; id: string; level: number } | null {
  const slash = member.indexOf("/");
  if (slash <= 0) return null;
  const target = member.slice(0, slash);
  const parsed = parseHintField(member.slice(slash + 1));
  if (!parsed) return null;
  return { target, id: parsed.id, level: parsed.level };
}

/** The price charged for a rung: its own price when set, else the event-wide
 *  configured cost. `??` not `||`, so an explicit free rung stays free. */
export function hintPrice(cost: number | null | undefined, fallback: number = HINT_COST): number {
  return cost ?? fallback;
}

/** Validate a ladder from a request or bundle. Text must be non-empty after
 *  trimming; cost is null/absent or an integer in the caller's range. The
 *  actual character cap belongs to the caller (client-safe modules cannot
 *  import the server store), so `maxTextLength` is passed in. */
export function validateHintLevels(
  raw: unknown,
  opts: { maxTextLength: number; maxCost: number },
): { ok: true; levels: HintLevelConfig[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "hints must be an array" };
  if (raw.length > HINT_LEVELS_MAX) {
    return { ok: false, error: `At most ${HINT_LEVELS_MAX} hints are allowed` };
  }
  const levels: HintLevelConfig[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `hints[${i}] must be an object` };
    }
    const v = entry as Record<string, unknown>;
    const unknown = Object.keys(v).filter((k) => k !== "text" && k !== "cost");
    if (unknown.length > 0) return { ok: false, error: `hints[${i}] has an unknown key` };
    if (typeof v.text !== "string" || !v.text.trim() || v.text.length > opts.maxTextLength) {
      return {
        ok: false,
        error: `hints[${i}].text must be a non-empty string of at most ${opts.maxTextLength} characters`,
      };
    }
    if (
      v.cost !== undefined &&
      v.cost !== null &&
      (typeof v.cost !== "number" || !Number.isInteger(v.cost) || v.cost < 0 || v.cost > opts.maxCost)
    ) {
      return { ok: false, error: `hints[${i}].cost must be an integer in [0, ${opts.maxCost}]` };
    }
    levels.push({ text: v.text.trim(), cost: typeof v.cost === "number" ? v.cost : null });
  }
  return { ok: true, levels };
}
