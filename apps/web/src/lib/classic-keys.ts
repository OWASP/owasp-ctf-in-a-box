// Shared `ctf:classic:*` key names/builders, the flag normalization recipe,
// and id generation. Dependency-free ON PURPOSE — no imports at all — so
// admin-store.ts (the demo seed and the master reset both need these names)
// can use it without a require cycle through classic-store.ts, which imports
// admin-store.ts itself. Same reasoning as quiz-keys.ts.

export const CLASSIC_CHALLENGES_KEY = "ctf:classic:challenges";
export const CLASSIC_FLAG_KEY = "ctf:classic:flag";
export const CLASSIC_FLAGNORM_KEY = "ctf:classic:flagnorm";
export const CLASSIC_CATEGORIES_KEY = "ctf:classic:categories";
/** Stories (#463): a JSON list of `{id, title, intro, steps}` — content, like
 *  the categories list, so a master reset keeps it. */
export const CLASSIC_STORIES_KEY = "ctf:classic:stories";
/** Story caps (#463). Here, not in classic-store.ts, so the client-safe
 *  bundle parser (classic-io.ts) enforces exactly what `setStories` does — an
 *  event-archive import clears the box before the store ever sees a story. */
export const CLASSIC_STORIES_MAX = 50;
export const CLASSIC_STORY_STEPS_MAX = 64;
export const CLASSIC_STORY_TITLE_MAX = 120;
export const CLASSIC_STORY_INTRO_MAX = 2000;
export const CLASSIC_POINTS_KEY = "ctf:classic:points";
export const CLASSIC_SOLVED_KEY = "ctf:classic:solved";
export const CLASSIC_SOLVECOUNT_KEY = "ctf:classic:solvecount";
export const CLASSIC_SOLVES_PREFIX = "ctf:classic:solves:";
export const CLASSIC_ATTEMPTS_PREFIX = "ctf:classic:attempts:";

export const classicSolvesKey = (login: string) => `${CLASSIC_SOLVES_PREFIX}${login}`;
export const classicAttemptsKey = (login: string) => `${CLASSIC_ATTEMPTS_PREFIX}${login}`;

/** Challenge ids look like "sql-injection-101-ab12cd" — same shape and cap as
 *  the quiz's, and validated in the same places (store write, API boundary). */
export const CLASSIC_ID_RE = /^[\w-]{1,64}$/;

/** Upper bound on a challenge's point value, mirroring `QUIZ_POINTS_MAX`.
 *  This is not cosmetic: `upsertChallenge` writes `points` verbatim into the
 *  challenge hash via `JSON.stringify`, and at >=1e21 JavaScript serialises a
 *  number in exponential form (`1e+21`), which SUBMIT_SCRIPT's anchored
 *  `'"points":(%-?%d+)[,}]'` match cannot read — the script would fall back to
 *  0 and silently award nothing for a correct flag. A sane cap keeps every
 *  storable value inside the plain-integer form the script can actually
 *  parse. */
export const CLASSIC_POINTS_MAX = 100000;
/** Paid-hint text per challenge (id -> text). SECRET until purchased — same
 *  storage rule as the flag hashes: separate from the public challenge
 *  record, so no list/read of `ctf:classic:challenges` can ever carry it.
 *  Read and charged through hint-store's shared reveal machinery (#190). */
export const CLASSIC_HINTS_KEY = "ctf:classic:hints";
/** Cap for organizer-authored hint text. */
export const CLASSIC_HINT_MAX = 1000;

/** Caps on the category list. Categories are rendered as headings on a page
 *  every contestant loads, and the whole list is stored in one string value. */
export const CLASSIC_CATEGORY_MAX_LEN = 64;
export const CLASSIC_CATEGORIES_MAX = 50;

/** THE canonical flag form. Used by the authoring path (what gets stored in
 *  `ctf:classic:flagnorm`) and by the submission path (what gets compared
 *  against it). Both sides MUST use this one function — the whole "compare
 *  whole values with Lua `==`" design depends on them agreeing byte for byte.
 *
 *  NFC before lowercasing, so a flag typed with a combining accent matches
 *  the same flag typed with a precomposed one — two spellings that look
 *  identical to the contestant reading them off a screen.
 *
 *  This must NEVER be reimplemented in Lua. `string.lower` is ASCII-only, so
 *  a Lua-side normalization of any non-ASCII flag disagrees with this one and
 *  produces a challenge nobody can solve. */
export function normalizeFlag(raw: string): string {
  return caseSensitiveFlagForm(raw).toLowerCase();
}

/** The comparison form for a CASE-SENSITIVE challenge (issue #193): the same
 *  trim and NFC as above, WITHOUT the lowercasing.
 *
 *  Only the lowercasing is optional. Trimming stays because a trailing space a
 *  contestant cannot see is not a wrong answer, and NFC stays because two
 *  spellings that render identically must still compare equal — neither of
 *  those is what "case-sensitive" is asking for.
 *
 *  `normalizeFlag` is defined in terms of this rather than beside it, so the
 *  two forms cannot drift: any future change to trimming or Unicode handling
 *  lands in both by construction. Both are still JS-only, for the Lua reason
 *  above. */
export function caseSensitiveFlagForm(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** The stored/compared form for a challenge, given its mode. THE one place
 *  that decides which of the two applies — callers pass the challenge's flag
 *  and its `caseSensitive` value and never branch themselves, because a
 *  branch written twice is a branch that eventually disagrees, and the failure
 *  it produces is "the correct flag is rejected". */
export function flagComparisonForm(raw: string, caseSensitive: boolean | undefined): string {
  return caseSensitive ? caseSensitiveFlagForm(raw) : normalizeFlag(raw);
}

const ID_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_SUFFIX_LENGTH = 6;
const ID_SLUG_MAX = 32;

/** A short random suffix. `Math.random` on purpose: the id is storage
 *  plumbing, exposed to every contestant in the `/flags` payload the moment
 *  the challenge is published, so guessing it buys nothing. It only has to
 *  not collide. `random` is injectable so tests pin a value. */
export function randomIdSuffix(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < ID_SUFFIX_LENGTH; i += 1) {
    out += ID_SUFFIX_ALPHABET[Math.floor(random() * ID_SUFFIX_ALPHABET.length)] ?? "0";
  }
  return out;
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, ID_SLUG_MAX)
    .replace(/-+$/, "");
}

/** Title slug + random suffix, so two identically-titled challenges cannot
 *  collide. A collision would overwrite the first challenge AND inherit every
 *  solve already recorded against its id.
 *
 *  The result is checked against `CLASSIC_ID_RE` before return — not
 *  decorative, because `suffix` is a parameter and a caller can hand in
 *  something the slug rules never would. This function's contract is that it
 *  cannot emit an id the store would reject. */
export function generateChallengeId(title: string, suffix: string = randomIdSuffix()): string {
  const candidate = `${slugifyTitle(title) || "c"}-${suffix}`;
  if (CLASSIC_ID_RE.test(candidate)) return candidate;
  return `c-${randomIdSuffix()}`;
}
