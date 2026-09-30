// Pure bundle parser, validator and serializer for the quiz's bulk
// import/export. Mirrors classic-io.ts, deliberately and closely: ADR 34
// settled what a content bundle is on this platform, and a second module
// inventing a second answer would leave organizers with two formats to learn
// and two validators to keep honest.
//
// This file is CLIENT-SAFE ON PURPOSE: the admin panel's bulk-import UI is a
// Client Component that needs to validate a pasted/uploaded bundle in the
// browser before it ever reaches the server, so this file must NEVER import
// quiz-store.ts (`server-only`) or anything that pulls in Upstash. It may only
// import from quiz-keys.ts, which is dependency-free for the same reason (see
// its header comment).
//
// Validation here MIRRORS `upsertQuestion` in quiz-store.ts and
// `parseQuestionPayload` in the admin route, field for field: a bundle that
// parses `ok: true` must contain only questions the single-question admin
// form would also have accepted, or the two authoring paths disagree about
// what is valid. If either of those changes, this must change with them.
//
// On top of that per-question mirror, a bundle carries two rules the
// single-question path has no equivalent for, because a bundle must be
// SELF-CONTAINED and is written by hand:
//
//   - No duplicate question ids within the file. A repeat would silently
//     overwrite the earlier question AND inherit every answer already
//     recorded against that id — never something to resolve with "last one
//     wins".
//   - No duplicate choice ids within one question. The admin form generates
//     choice ids and so cannot produce this, which is exactly why the store
//     never had to check: a hand-written file can. Two choices sharing an id
//     make the radio group ambiguous and make `correct` unable to name one of
//     them, so the question would be unanswerable in a way nothing downstream
//     reports.
//
// The quiz's retry-gate settings (`quizMaxAttempts`, `quizRetryAfterMin`) are
// deliberately NOT part of the bundle, matching classic's exclusion of
// `classicCooldownSec`. They are event policy rather than content, they are
// live-editable in /admin, and folding them in would mean importing a
// question set mid-event could silently re-open or shut a retry gate an
// organizer had already tuned — a change with no undo and no obvious cause.

import { QUIZ_ID_RE, QUIZ_POINTS_MAX, canonicalizeChoices } from "@/lib/quiz-keys";

export const QUIZ_BUNDLE_VERSION = 1;

export type QuizBundleChoice = {
  id: string;
  label: string;
};

export type QuizBundleQuestion = {
  id: string;
  prompt: string;
  type: "single" | "multi";
  choices: QuizBundleChoice[];
  points: number;
  order: number;
  correct: string[];
};

export type QuizBundle = {
  version: number;
  questions: QuizBundleQuestion[];
};

/** `where` is the indexed path, `message` the rule it broke — never the
 *  submitted value or a key name. The list goes back to the admin client
 *  verbatim, and a bundle's values are arbitrary text: a `correct` entry is
 *  the answer key itself (#500). */
export type ImportError = { where: string; message: string };

export type ParseResult = { ok: true; bundle: QuizBundle } | { ok: false; errors: ImportError[] };

const QUESTION_KEYS = ["id", "prompt", "type", "choices", "points", "order", "correct"] as const;
const QUESTION_KEY_SET = new Set<string>(QUESTION_KEYS);
const CHOICE_KEY_SET = new Set<string>(["id", "label"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates one question's `choices` array and returns the set of choice ids
 *  that passed, for `correct` to be checked against. Returning the ids rather
 *  than a boolean is what lets a bad `correct` entry be reported against the
 *  choice list the file actually declared, instead of against nothing. */
function validateChoices(raw: unknown, base: string, errors: ImportError[]): Map<string, number> {
  // id -> the index it first appeared at, so a duplicate names the position
  // it collides with rather than the id itself (#500).
  const ids = new Map<string, number>();
  if (!Array.isArray(raw)) {
    errors.push({ where: `${base}.choices`, message: '"choices" must be an array' });
    return ids;
  }
  if (raw.length === 0) {
    errors.push({ where: `${base}.choices`, message: "A question needs at least one choice" });
    return ids;
  }
  raw.forEach((entry, i) => {
    const where = `${base}.choices[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push({ where, message: "Each choice must be an object" });
      return;
    }
    const unknownKeys = Object.keys(entry).filter((k) => !CHOICE_KEY_SET.has(k));
    if (unknownKeys.length > 0) {
      errors.push({ where, message: `Unknown key(s) (${unknownKeys.length}) — a choice is exactly { id, label }` });
    }
    if (typeof entry.id !== "string" || !QUIZ_ID_RE.test(entry.id)) {
      errors.push({ where: `${where}.id`, message: "Choice id must be 1-64 letters, digits, _ or -" });
      return;
    }
    if (typeof entry.label !== "string" || !entry.label.trim()) {
      errors.push({ where: `${where}.label`, message: "Choice label is required" });
    }
    // Bundle-only: the admin form generates choice ids, so only a
    // hand-written file can collide. See this file's header.
    const first = ids.get(entry.id);
    if (first !== undefined) {
      errors.push({ where: `${where}.id`, message: `Duplicate choice id — the same as ${base}.choices[${first}].id` });
      return;
    }
    ids.set(entry.id, i);
  });
  return ids;
}

/** Validates one question object against exactly the rules `upsertQuestion`
 *  and the admin route's `parseQuestionPayload` enforce between them, plus
 *  the bundle-only duplicate-choice-id rule. Pushes every problem found onto
 *  `errors` rather than stopping at the first — the whole point of a bulk
 *  path is one pass over every row. */
function validateQuestion(raw: unknown, index: number, errors: ImportError[]): void {
  const base = `questions[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push({ where: base, message: "Each question must be an object" });
    return;
  }

  const unknownKeys = Object.keys(raw).filter((k) => !QUESTION_KEY_SET.has(k));
  if (unknownKeys.length > 0) {
    errors.push({ where: base, message: `Unknown key(s) (${unknownKeys.length}) — a question has only ${QUESTION_KEYS.join(", ")}` });
  }

  const id = raw.id;
  if (typeof id !== "string" || !QUIZ_ID_RE.test(id)) {
    errors.push({ where: `${base}.id`, message: "Question id must be 1-64 letters, digits, _ or -" });
  }

  // TRIMMED, not merely non-empty, mirroring the admin route's prompt check —
  // and that check is a safety gate, not cosmetics: the delete confirmation's
  // required typed phrase IS the trimmed prompt, and `ConfirmModal` reads an
  // empty phrase as "no confirmation needed", so a blank-prompt question
  // would delete on a single click.
  const prompt = raw.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    errors.push({ where: `${base}.prompt`, message: "Question prompt is required" });
  }

  const type = raw.type;
  if (type !== "single" && type !== "multi") {
    errors.push({ where: `${base}.type`, message: 'Question type must be "single" or "multi"' });
  }

  // Mirrors upsertQuestion's points check verbatim: points are written
  // verbatim into the question hash and read back INSIDE GRADE_SCRIPT by
  // pattern-matching a plain integer, so a non-integer or out-of-range value
  // here is not cosmetic — see QUIZ_POINTS_MAX's doc comment.
  const points = raw.points;
  if (typeof points !== "number" || !Number.isInteger(points) || points < 0 || points > QUIZ_POINTS_MAX) {
    errors.push({ where: `${base}.points`, message: `Question points must be an integer in [0, ${QUIZ_POINTS_MAX}]` });
  }

  const order = raw.order;
  if (typeof order !== "number" || !Number.isInteger(order)) {
    errors.push({ where: `${base}.order`, message: "Question order must be an integer" });
  }

  const choiceIds = validateChoices(raw.choices, base, errors);

  const correct = raw.correct;
  if (!Array.isArray(correct) || correct.length === 0) {
    errors.push({ where: `${base}.correct`, message: "A question needs at least one correct choice" });
    return;
  }
  if (!correct.every((c) => typeof c === "string")) {
    errors.push({ where: `${base}.correct`, message: "Correct entries must be choice ids" });
    return;
  }
  // Only meaningful once the choice list itself parsed — an empty `choiceIds`
  // from a malformed `choices` array would otherwise report every correct id
  // as unknown, burying the real error under noise.
  if (choiceIds.size > 0) {
    // Named by position: a correct entry IS the answer key, so echoing it
    // would put the answer on the admin screen (#500).
    (correct as string[]).forEach((c, j) => {
      if (!choiceIds.has(c)) {
        errors.push({ where: `${base}.correct[${j}]`, message: "must be one of this question's choice ids" });
      }
    });
  }
  // Canonicalized (deduped) BEFORE the arity check, exactly as
  // `upsertQuestion` does it: `["a","a"]` on a single-choice question is one
  // correct answer, not two, and the store would accept it.
  if (type === "single" && canonicalizeChoices(correct as string[]).length !== 1) {
    errors.push({
      where: `${base}.correct`,
      message: `A "single" question must have exactly one correct choice, got ${canonicalizeChoices(correct as string[]).length}`,
    });
  }
}

/** Cross-row rule with no single-question equivalent: a repeated id within
 *  one file is always a mistake (it would silently overwrite the earlier
 *  question, inheriting every answer already recorded against that id),
 *  never something to resolve with "last one wins". */
function checkDuplicateIds(questions: readonly unknown[], errors: ImportError[]): void {
  const seen = new Map<string, number>();
  questions.forEach((raw, i) => {
    if (!isPlainObject(raw) || typeof raw.id !== "string") return;
    const first = seen.get(raw.id);
    if (first !== undefined) {
      errors.push({ where: `questions[${i}].id`, message: `Duplicate question id — the same as questions[${first}].id` });
      return;
    }
    seen.set(raw.id, i);
  });
}

/** Parses and validates a bundle document, accumulating EVERY problem found
 *  rather than stopping at the first — an organizer pasting a 50-row file
 *  needs every issue in one pass, not fifty round trips.
 *
 *  Validated in order: JSON parse -> top-level shape -> `version` -> each
 *  question (unknown keys, then each field, then its choices and correct set)
 *  -> cross-row rules (duplicate ids). Returns `{ ok: true, bundle }` only
 *  when zero errors were collected across the whole pass. */
export function parseBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately generic, with NO part of the underlying SyntaxError or the
    // raw input echoed back — the same rule classic-io.ts follows, for the
    // same reason: V8's JSON.parse message embeds a short excerpt of the
    // offending text verbatim, and on a malformed quiz bundle that excerpt
    // can contain answer-key text. The response is admin-only, so no
    // privilege boundary is crossed, but it can still land on a screen-shared
    // admin panel mid-event, and the excerpt cannot be reliably trimmed out
    // after the fact (V8 does not escape quotes occurring within it).
    return { ok: false, errors: [{ where: "(document)", message: "Invalid JSON" }] };
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.questions)) {
    return {
      ok: false,
      errors: [{ where: "(document)", message: 'Bundle must be an object with a "questions" array' }],
    };
  }

  const errors: ImportError[] = [];

  if (parsed.version !== QUIZ_BUNDLE_VERSION) {
    errors.push({ where: "version", message: `Unsupported bundle version: expected ${QUIZ_BUNDLE_VERSION}` });
  }

  const rawQuestions = parsed.questions;
  rawQuestions.forEach((q, i) => validateQuestion(q, i, errors));
  checkDuplicateIds(rawQuestions, errors);

  if (errors.length > 0) return { ok: false, errors };

  // Every question passed validation above (errors.length === 0), so this
  // cast is sound: each entry has exactly the required keys and types.
  const questions = rawQuestions as QuizBundleQuestion[];
  return { ok: true, bundle: { version: QUIZ_BUNDLE_VERSION, questions } };
}

/** Indented, not minified — an organizer edits this file by hand. Ends in a
 *  trailing newline, like every other text file in the repo. */
export function serializeBundle(bundle: QuizBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}
