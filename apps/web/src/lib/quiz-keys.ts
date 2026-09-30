// Shared `ctf:quiz:*` Redis key names/builders and the answer-key
// canonicalization recipe. Deliberately its OWN dependency-free module (no
// imports, nothing that could import admin-store.ts or quiz-store.ts back):
// quiz-store.ts already imports admin-store.ts (for getAdminSettings/
// effectivePaused), so admin-store.ts importing quiz-store.ts's key
// constants would be a require cycle. Putting the keys here instead of
// duplicating them in both files makes the two ways of writing a quiz key
// structurally incapable of drifting apart — see AGENTS.md's "three readers
// must change in lockstep" rule, born from exactly this failure mode
// elsewhere in the kit.

export const QUIZ_QUESTIONS_KEY = "ctf:quiz:questions";
export const QUIZ_KEY_KEY = "ctf:quiz:key";
export const QUIZ_POINTS_KEY = "ctf:quiz:points";
export const QUIZ_ANSWERED_KEY = "ctf:quiz:answered";
/** login -> ISO time of that login's latest award (#522). */
export const QUIZ_LAST_AT_KEY = "ctf:quiz:lastAt";
export const QUIZ_ANSWERS_PREFIX = "ctf:quiz:answers:";
export const QUIZ_ATTEMPTS_PREFIX = "ctf:quiz:attempts:";

export const quizAnswersKey = (login: string) => `${QUIZ_ANSWERS_PREFIX}${login}`;
export const quizAttemptsKey = (login: string) => `${QUIZ_ATTEMPTS_PREFIX}${login}`;

/** Canonicalizes a set of choice ids into the sorted, deduped array
 *  quiz-store stores (JSON-stringified) as `ctf:quiz:key`'s correct-answer
 *  set, and that a submission must match byte-for-byte after the same
 *  treatment. The single source of truth for this recipe — used by
 *  quiz-store's `upsertQuestion` (authoring) and `answerQuestion`
 *  (grading), and by admin-store's demo seed, so all three can never
 *  silently disagree about what "the stored key format" means. */
export function canonicalizeChoices(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Question/choice ids look like "q1" or "sqli-basics" — reject anything
 *  weirder before it reaches Redis, mirroring hint-store's CHALLENGE_ID_RE.
 *
 *  It lives HERE, not in quiz-store.ts (which re-exports it, so every existing
 *  `import { QUIZ_ID_RE } from "@/lib/quiz-store"` still resolves to this one
 *  object), because `generateQuestionId` below has to check its own output
 *  against the very pattern the store validates with, and the generator runs
 *  in the browser: quiz-store.ts is `server-only` and importing it from the
 *  admin panel's Client Component would break the client build. A second copy
 *  of the pattern on the client would be exactly the silent desync this
 *  module exists to prevent. */
export const QUIZ_ID_RE = /^[\w-]{1,64}$/;

/** Upper bound on a question's point value, mirroring `HINT_COST_MAX` in
 *  admin-store.ts. This is not cosmetic: `upsertQuestion` writes `points`
 *  verbatim into the question hash via `JSON.stringify`, and at >=1e21
 *  JavaScript serialises a number in exponential form (`1e+21`), which
 *  GRADE_SCRIPT's anchored `'"points":(%-?%d+)[,}]'` match cannot read — the
 *  script would fall back to 0 and silently award nothing for a correct
 *  answer. A sane cap keeps every storable value inside the plain-integer
 *  form the script can actually parse.
 *
 *  It lives HERE, alongside `QUIZ_ID_RE` and for the same reason
 *  (`CLASSIC_POINTS_MAX` sits in classic-keys.ts on the same argument):
 *  `quiz-io.ts` validates a pasted bundle IN THE BROWSER against the very
 *  bound the store enforces, and quiz-store.ts is `server-only`. It is
 *  re-exported from quiz-store.ts, so every existing import still resolves
 *  to this one value. */
export const QUIZ_POINTS_MAX = 100000;

/** Characters an auto-generated id's random suffix is drawn from. Lowercase
 *  alphanumerics only: every one of them is inside `QUIZ_ID_RE`, and the set
 *  has no visually ambiguous pairing worth caring about here because nobody
 *  has to retype an id (the delete confirmation asks for the PROMPT). */
const ID_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_SUFFIX_LENGTH = 6;

/** Longest slug taken from the prompt. 32 + "-" + 6 = 39, comfortably inside
 *  `QUIZ_ID_RE`'s 64-character cap with room for the cap to be reached only
 *  by a caller-supplied suffix (which `generateQuestionId` re-checks). */
const ID_SLUG_MAX = 32;

/** A short random suffix for a generated question id.
 *
 *  `Math.random` on purpose: this is not a secret and guessing it buys
 *  nothing — the id is storage plumbing, exposed to every contestant in the
 *  `/quiz` payload the moment the question is published. All it has to do is
 *  not collide, and 36^6 (~2.2 billion) draws is far past what an event with
 *  a few dozen questions needs. `random` is injectable so tests can pin a
 *  value instead of asserting on chance. */
export function randomIdSuffix(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < ID_SUFFIX_LENGTH; i += 1) {
    out += ID_SUFFIX_ALPHABET[Math.floor(random() * ID_SUFFIX_ALPHABET.length)] ?? "0";
  }
  return out;
}

/** The readable half of a generated id: the prompt, lowercased, with every
 *  run of non-alphanumerics collapsed to a single "-", trimmed of leading and
 *  trailing "-", and clipped to `ID_SLUG_MAX`.
 *
 *  Returns "" for a prompt with nothing sluggable in it (all punctuation, or
 *  entirely non-Latin script — a perfectly reasonable prompt this ASCII rule
 *  simply cannot transliterate). `generateQuestionId` substitutes "q" in that
 *  case, so such a question gets an opaque-but-valid id rather than none. */
export function slugifyPrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, ID_SLUG_MAX)
    .replace(/-+$/, "");
}

/** Builds a question id from its prompt, so an organizer never has to invent
 *  one. The id is storage plumbing — it is the field name in
 *  `ctf:quiz:questions` and `ctf:quiz:key`, and the reference every
 *  contestant's `ctf:quiz:answers:<login>` row is written against — and
 *  nothing about it needs a human's judgement, only a value that is stable,
 *  unique, and legible enough to recognise in an audit line.
 *
 *  Hence prompt-slug + random suffix rather than the slug alone: two
 *  questions worded identically (a deliberate near-duplicate, or the same
 *  question re-added after a delete) must not land on the same id, because
 *  the second one would silently overwrite the first AND inherit every answer
 *  already recorded against it.
 *
 *  The result is checked against `QUIZ_ID_RE` — the store's own validator —
 *  before it is returned. That check is not decorative: `suffix` is a
 *  parameter, so a caller can hand in something the slug rules never would,
 *  and this function's contract is that it cannot emit an id
 *  `upsertQuestion` would reject. */
export function generateQuestionId(prompt: string, suffix: string = randomIdSuffix()): string {
  const candidate = `${slugifyPrompt(prompt) || "q"}-${suffix}`;
  if (QUIZ_ID_RE.test(candidate)) return candidate;
  // The supplied suffix carried characters (or length) the store's pattern
  // refuses. Fall back to a form built entirely from the alphabet above,
  // which satisfies the pattern by construction.
  return `q-${randomIdSuffix()}`;
}
