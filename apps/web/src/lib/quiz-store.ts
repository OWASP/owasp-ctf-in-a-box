import "server-only";
// Re-exported, not redeclared — the admin UI cannot import a server-only
// module, so the value lives in the dependency-free defaults file.
export { QUIZ_MAX_ATTEMPTS, QUIZ_RETRY_AFTER_MIN } from "./quiz-defaults";
import { QUIZ_MAX_ATTEMPTS, QUIZ_RETRY_AFTER_MIN } from "./quiz-defaults";
import { effectivePaused, getAdminSettings } from "@/lib/admin-store";
import { errorLabel } from "@/lib/error-label";
import { QUIZ_BUNDLE_VERSION, type QuizBundle, type QuizBundleQuestion } from "@/lib/quiz-io";
import { foldTeamItems } from "@/lib/leaderboard/team-fold";
import { readLastAt } from "@/lib/last-at";
import { upstashEval, upstashPipeline } from "@/lib/upstash";
import {
  QUIZ_QUESTIONS_KEY as QUESTIONS_KEY,
  QUIZ_KEY_KEY as KEY_KEY,
  QUIZ_POINTS_KEY as POINTS_KEY,
  QUIZ_ANSWERED_KEY as ANSWERED_KEY,
  QUIZ_LAST_AT_KEY as LAST_AT_KEY,
  quizAnswersKey as answersKey,
  quizAttemptsKey as attemptsKey,
  canonicalizeChoices,
  QUIZ_ID_RE,
  QUIZ_POINTS_MAX,
} from "@/lib/quiz-keys";

/**
 * The quiz module. This file is the only place that touches `ctf:quiz:*`
 * Redis keys during normal contestant and authoring activity — answering,
 * grading, and question authoring/deletion all go through it, and nothing
 * else should read or write these keys for those flows. Two admin-store.ts
 * bulk-maintenance paths are the deliberate exception, reusing this file's
 * key constants/`canonicalizeChoices` (via quiz-keys.ts) rather than going
 * through these functions: `seedDemoData()` HSETs the questions/key/answers/
 * aggregate hashes directly when seeding demo data, and the master reset's
 * `scanDelByPrefix()` SCAN+DELs the per-login answers/attempts hashes and
 * the two aggregate hashes (never the questions/key hashes — those are
 * organizer content the reset keeps). See docs/architecture.md's "Quiz data
 * flow" for the full picture.
 *
 * Key layout:
 *   ctf:quiz:questions          hash, id -> JSON Question (public-safe; this
 *                                is what contestants see)
 *   ctf:quiz:key                hash, id -> JSON sorted array of correct
 *                                choice ids (SECRET from contestants — never
 *                                returned by any function a contestant-facing
 *                                route can call; readable by the admin-gated
 *                                `listQuestionsForAdmin` alone)
 *   ctf:quiz:lastAt             hash, login -> ISO time of that login's
 *                                latest award, written by GRADE_SCRIPT with
 *                                the totals (#522) — the leaderboard's
 *                                "whoever got there first" tiebreak
 *   ctf:quiz:answers:<login>    hash, id -> JSON {choices, points, at} —
 *                                records ONLY correct answers. Points are
 *                                captured at answer time, so a later
 *                                re-pricing of a question never rewrites
 *                                history.
 *   ctf:quiz:attempts:<login>   hash, id -> JSON {attempts, firstAt, lastAt, lastAtMs}
 *                                `firstAt` is the FIRST submission's time,
 *                                carried forward across rewrites; absent on
 *                                rows written before it existed (issue #169).
 *                                — every attempt, right or wrong; Task 3's
 *                                retry gate reads this. `lastAtMs` (a plain
 *                                epoch-ms mirror of `lastAt`) exists only so
 *                                GRADE_SCRIPT can do cooldown arithmetic in
 *                                Lua without parsing an ISO-8601 string;
 *                                readers outside this file should use `lastAt`.
 *
 * Secrecy boundary — it is a CONTESTANT boundary, not an absolute one:
 * `ctf:quiz:key` is kept out of every contestant path the same way the scoring
 * rubric stays private. (This used to cite hint text in "a scorer-owned hash
 * the app only ever reads" as the parallel; no such producer exists — see
 * hint-store.ts and issue #334.) Two readers, deliberately kept apart:
 *
 *   - `listQuestions` (the CONTESTANT path — `/quiz`, the leaderboard
 *     overlay) never issues a command against `ctf:quiz:key`, and the
 *     `Question` type it returns has no field that could carry a
 *     correct-answer id. That property is absolute and must stay that way.
 *   - `listQuestionsForAdmin` (the ADMIN path — `GET /api/admin/quiz`, which
 *     is behind `requireAdmin`) DOES read the key, and returns it in a
 *     separate `AdminQuestion` shape that is deliberately not assignable to
 *     `Question` (see its doc comment). It exists because withholding the
 *     key from an organizer who is editing the question buys nothing —
 *     anyone through that gate can already delete the question, rewrite its
 *     answer, or reset the whole event — while costing real correctness: an
 *     edit form that starts with nothing marked correct makes every typo fix
 *     a chance to silently re-define what counts as right, with no diff and
 *     no warning.
 *
 * Grading (which also reads the key) is likewise server-only and never
 * exposed by a route that echoes its input back to the caller.
 *
 * The key ALWAYS stores a sorted JSON array of correct choice ids, even for
 * `"single"` questions (the one-element case) — so grading has one code
 * path for both question types, not two.
 *
 * Callers (the /api/quiz route handlers) are responsible for authenticating
 * the session and deriving `login` server-side — nothing here trusts
 * client-supplied identity.
 */

// Key names/builders live in ./quiz-keys (a dependency-free module) rather
// than as local consts here — see quiz-keys.ts's header comment for why.
// POINTS_KEY/ANSWERED_KEY are running totals, and LAST_AT_KEY the latest
// award time, updated atomically by the grading script alongside the
// per-login answer row — the same
// `ctf:hints:spent` trick, so a leaderboard overlay costs one HGETALL each
// regardless of board size.

/** Default cap on graded attempts per question before the retry gate
 *  refuses further submissions. 0 would mean unlimited (not the default). */


/** Default cooldown, in minutes, after a login's last attempt on a question
 *  before it may try again. 0 would mean no cooldown (not the default). */


/** Question/choice id pattern, re-exported so callers (e.g. the answer route)
 *  validate against this exact pattern instead of keeping their own copy that
 *  could silently desync.
 *
 *  It is DEFINED in quiz-keys.ts rather than here: the admin panel's
 *  id generator (`generateQuestionId`) runs in the browser and must check its
 *  output against the same object this file validates with, and this file is
 *  `server-only`. Moving it kept every existing
 *  `import { QUIZ_ID_RE } from "@/lib/quiz-store"` working unchanged. */
export { QUIZ_ID_RE };

/** Re-exported from quiz-keys.ts for the same reason `QUIZ_ID_RE` is: the
 *  bulk-import validator (`quiz-io.ts`) runs in the browser and must check a
 *  pasted bundle against the very bound this `server-only` file enforces.
 *  See its definition there for why the cap exists at all. */
export { QUIZ_POINTS_MAX };

/** Thrown by `upsertQuestion`/`deleteQuestion` for genuine input-validation
 *  failures (bad id/choice format, non-integer points, a `correct` id not
 *  among the question's choices, wrong arity for a `"single"` question) —
 *  mirroring `AdminValidationError` in admin-store.ts. Callers (the admin
 *  route) can distinguish this from a plain `Error`, which these functions
 *  still throw for a genuine Upstash/infra failure, so a caller-facing
 *  status code can tell "your payload was bad" apart from "the store
 *  failed" instead of misreporting one as the other. */
export class QuizValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "QuizValidationError";
    this.field = field;
  }
}

export type QuestionType = "single" | "multi";

export type Choice = {
  id: string;
  label: string;
};

/** Public-safe question shape. Never carries the correct answer. */
export type Question = {
  id: string;
  prompt: string;
  type: QuestionType;
  choices: Choice[];
  points: number;
  order: number;
};

/** One question as the ADMIN-GATED surface sees it: the public-safe record
 *  and its correct-choice set, side by side but in two SEPARATE fields.
 *
 *  The nesting is the point, not an accident of style. The obvious shape —
 *  `Question & { correct: string[] }` — is structurally still a `Question`,
 *  so handing an admin record to a contestant-facing component or view model
 *  (`<QuizBoard questions={rows} />`) would type-check and quietly ship the
 *  answer key to every visitor. This shape is NOT assignable to `Question`,
 *  so that mistake is a compile error; reaching the public half takes an
 *  explicit `.question`, which is a thing you write on purpose rather than a
 *  thing you forget. That is what keeps the keyless contestant guarantee a
 *  property of the types instead of a property of remembering which variable
 *  you happen to be holding. */
export type AdminQuestion = {
  /** Byte-for-byte what `listQuestions` would have returned for this id. */
  question: Question;
  /** The correct choice ids, sorted, exactly as `ctf:quiz:key` stores them.
   *  Empty only if the key row is missing or unparseable — a question in
   *  that state can never be answered correctly, which is worth seeing in
   *  the edit form rather than hiding. */
  correct: string[];
};

function isChoice(value: unknown): value is Choice {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Choice).id === "string" &&
    typeof (value as Choice).label === "string"
  );
}

function parseQuestion(raw: string): Question | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const q = parsed as Record<string, unknown>;
    if (typeof q.id !== "string") return null;
    if (typeof q.prompt !== "string") return null;
    if (q.type !== "single" && q.type !== "multi") return null;
    if (!Array.isArray(q.choices) || !q.choices.every(isChoice)) return null;
    if (typeof q.points !== "number") return null;
    if (typeof q.order !== "number") return null;
    return {
      id: q.id,
      prompt: q.prompt,
      type: q.type,
      choices: q.choices as Choice[],
      points: q.points,
      order: q.order,
    };
  } catch {
    return null;
  }
}

/** All quiz questions, ascending by `order` then `id`. Answer key excluded —
 *  this issues a single HGETALL against the public-safe hash only, and the
 *  `Question` shape it returns has nowhere to put a correct-answer id even
 *  if it did. This is the ONLY list function a contestant-facing route (or
 *  the leaderboard) may call. */
export async function listQuestions(): Promise<Question[]> {
  const [res] = await upstashPipeline([["HGETALL", QUESTIONS_KEY]]);
  const flat = Array.isArray(res.result) ? (res.result as string[]) : [];
  const questions: Question[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const parsed = parseQuestion(flat[i + 1]);
    if (parsed) questions.push(parsed);
  }
  questions.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return questions;
}

/** Parses one `ctf:quiz:key` row — a JSON array of choice-id strings. */
function parseCorrect(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/** The same list, WITH each question's correct-choice set — for the
 *  admin-gated authoring surface ONLY (`GET /api/admin/quiz`, behind
 *  `requireAdmin`).
 *
 *  Named so a call site reads as a decision rather than a default: any route
 *  reaching for this one is asserting it has already established the caller
 *  is an organizer. Contestant-facing code calls `listQuestions` instead,
 *  and the `AdminQuestion` return shape (not assignable to `Question`) is
 *  what stops the two from being mixed up by accident.
 *
 *  Both hashes are read in ONE pipeline, so the questions and their keys
 *  come from the same instant — an edit form can never prefill a correct set
 *  belonging to a version of the question it isn't showing. */
export async function listQuestionsForAdmin(): Promise<AdminQuestion[]> {
  const [questionsRes, keyRes] = await upstashPipeline([
    ["HGETALL", QUESTIONS_KEY],
    ["HGETALL", KEY_KEY],
  ]);

  const keyFlat = Array.isArray(keyRes.result) ? (keyRes.result as string[]) : [];
  const correctById = new Map<string, string[]>();
  for (let i = 0; i < keyFlat.length; i += 2) {
    const parsed = parseCorrect(keyFlat[i + 1]);
    if (parsed) correctById.set(keyFlat[i], parsed);
  }

  const flat = Array.isArray(questionsRes.result) ? (questionsRes.result as string[]) : [];
  const rows: AdminQuestion[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const question = parseQuestion(flat[i + 1]);
    if (question) rows.push({ question, correct: correctById.get(question.id) ?? [] });
  }
  rows.sort((a, b) => a.question.order - b.question.order || a.question.id.localeCompare(b.question.id));
  return rows;
}

/** Creates or replaces a question and its correct-answer set. Writes the
 *  question (no answer) and the sorted key array (answer only, no prompt) in
 *  ONE pipeline call so the two hashes never observably disagree.
 *
 *  Returns what was actually STORED, as an `AdminQuestion` — the correct set
 *  after dedupe-and-sort, not the caller's raw array. The admin route echoes
 *  this back so the authoring client's in-memory list holds the canonical
 *  set the store now has, identical to what a later `listQuestionsForAdmin`
 *  would hand it. Contestant-facing code never sees this value. */
export async function upsertQuestion(q: Question, correct: string[]): Promise<AdminQuestion> {
  if (!QUIZ_ID_RE.test(q.id)) throw new QuizValidationError("id", `Invalid question id: ${q.id}`);
  for (const choice of q.choices) {
    if (!QUIZ_ID_RE.test(choice.id)) {
      throw new QuizValidationError("choices", `Invalid choice id: ${choice.id}`);
    }
  }
  // Points get written verbatim into the question hash and read back INSIDE
  // GRADE_SCRIPT by pattern-matching a plain integer (see GRADE_SCRIPT's
  // comment) — a non-integer here would either fail to match (silently
  // scoring 0) or, worse, corrupt HINCRBY mid-script after the attempt bump
  // and answer row had already been written with no way to roll back.
  if (!Number.isInteger(q.points) || q.points < 0) {
    throw new QuizValidationError("points", `Question points must be a non-negative integer, got ${q.points}`);
  }
  // Upper bound too — see QUIZ_POINTS_MAX: past ~1e21 `JSON.stringify` emits
  // exponential notation the script's integer match can't read, so an
  // uncapped value would store fine and then score 0 forever.
  if (q.points > QUIZ_POINTS_MAX) {
    throw new QuizValidationError("points", `Question points must be an integer in [0, ${QUIZ_POINTS_MAX}]`);
  }
  const choiceIds = new Set(q.choices.map((c) => c.id));
  for (const id of correct) {
    if (!choiceIds.has(id)) throw new QuizValidationError("correct", `Correct choice id not among choices: ${id}`);
  }
  // Dedupe-then-sort via the shared `canonicalizeChoices` recipe BEFORE the
  // length check: `answerQuestion` canonicalizes a submission the same way,
  // and the whole "string-compare stands in for set-compare" design in
  // GRADE_SCRIPT depends on both sides canonicalizing identically. Without
  // this, a duplicate id here (e.g. ["a","a"]) would store a correct set no
  // submission could ever equal — a permanently unanswerable question that
  // silently burns every attempt against it.
  const sortedCorrect = canonicalizeChoices(correct);
  // A "single" question must have exactly one correct choice — with more
  // than one, the all-or-nothing grading rule could never be satisfied.
  if (q.type === "single" && sortedCorrect.length !== 1) {
    throw new QuizValidationError(
      "correct",
      `A "single" question must have exactly one correct choice, got ${sortedCorrect.length}`,
    );
  }

  const results = await upstashPipeline([
    ["HSET", QUESTIONS_KEY, q.id, JSON.stringify(q)],
    ["HSET", KEY_KEY, q.id, JSON.stringify(sortedCorrect)],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HSET failed: ${failed.error}`);

  return { question: q, correct: sortedCorrect };
}

/** What a bulk import did, for the panel's after-import line and the audit
 *  trail: how many ids were NEW to the bank and how many already existed and
 *  were replaced. No `categories` counterpart — the quiz has no category
 *  concept, which is the one structural difference from classic's summary. */
export type QuizImportSummary = { created: number; updated: number };

/** Applies a PRE-VALIDATED bundle (produced by `quiz-io.ts`'s `parseBundle`)
 *  to the store: upserts every question it contains along with its answer
 *  key.
 *
 *  `importBundle` re-validates NOTHING — its whole contract is that the
 *  caller already ran the bundle through `parseBundle`. Validation lives in
 *  exactly one place so the single-question admin form and this bulk path
 *  can never quietly grow different rules; a caller that skips `parseBundle`
 *  before calling this is the one at fault, not something this function
 *  guards against. Mirrors `importBundle` in classic-store.ts.
 *
 *  UPSERT BY ID, NEVER DELETE. A question already in the bank but absent from
 *  this bundle is left completely untouched — there is no HDEL anywhere on
 *  this path. That is the whole reason import is safe to run against a live
 *  quiz: an organizer can import a partial file (this week's new questions,
 *  say) without erasing anything else already authored. Existing ids are read
 *  FIRST (one HKEYS) so `created`/`updated` reflect what was already in the
 *  bank before this call, not what ends up there after.
 *
 *  Every question write and every key write happens in ONE `upstashPipeline`
 *  call — the same discipline `upsertQuestion` follows for a single row — so
 *  the question hash and the answer-key hash can never observably disagree
 *  partway through a bulk import. A question stored without its key is
 *  precisely the state that makes a question unanswerable, so this is not a
 *  tidiness point.
 *
 *  `prompt` is trimmed and `correct` is canonicalized through the shared
 *  `canonicalizeChoices` recipe, for the same reasons `upsertQuestion` does
 *  both: a bundle-authored row must end up byte-identical to a form-authored
 *  one, and GRADE_SCRIPT's string-compare stands in for a set-compare only
 *  while both sides canonicalize the same way. */
export async function importBundle(bundle: QuizBundle): Promise<QuizImportSummary> {
  const [idsRes] = await upstashPipeline([["HKEYS", QUESTIONS_KEY]]);
  // The membership read must have succeeded before anything is written: a
  // failed HKEYS would otherwise read as "no questions yet" and report every
  // row `created`. Same guard as classic's and ai's (#261).
  if (idsRes.error) throw new Error(`Upstash read failed before import: ${idsRes.error}`);
  const existingIds = new Set(Array.isArray(idsRes.result) ? (idsRes.result as string[]) : []);

  let created = 0;
  let updated = 0;
  const commands: (string | number)[][] = [];
  for (const q of bundle.questions) {
    if (existingIds.has(q.id)) updated += 1;
    else created += 1;

    // Built field by field, mirroring upsertQuestion's write: the correct set
    // never reaches this record, only the separate key hash below.
    const record: Question = {
      id: q.id,
      prompt: q.prompt.trim(),
      type: q.type,
      choices: q.choices.map((c) => ({ id: c.id, label: c.label })),
      points: q.points,
      order: q.order,
    };
    commands.push(["HSET", QUESTIONS_KEY, q.id, JSON.stringify(record)]);
    commands.push(["HSET", KEY_KEY, q.id, JSON.stringify(canonicalizeChoices(q.correct))]);
  }

  const results = await upstashPipeline(commands);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash bulk import failed: ${failed.error}`);

  return { created, updated };
}

/** The current question bank, in the same shape `importBundle` accepts — so
 *  exporting then re-importing round-trips (every id already exists, so
 *  nothing is reported `created`), which is what makes an export usable as a
 *  backup. Reads the admin-gated question list, so every row comes back with
 *  its correct set alongside the public fields, matching
 *  `QuizBundleQuestion`. */
export async function exportBundle(): Promise<QuizBundle> {
  const rows = await listQuestionsForAdmin();
  const questions: QuizBundleQuestion[] = rows.map(({ question: q, correct }) => ({
    id: q.id,
    prompt: q.prompt,
    type: q.type,
    choices: q.choices.map((c) => ({ id: c.id, label: c.label })),
    points: q.points,
    order: q.order,
    correct,
  }));
  return { version: QUIZ_BUNDLE_VERSION, questions };
}

/** Removes a question and its answer key together — nothing else.
 *
 *  Scope, stated plainly because it is easy to assume otherwise: this
 *  retires the question from the quiz (contestants stop seeing it, and it
 *  can no longer be answered — GRADE_SCRIPT's step 1 returns `missing`
 *  without the key), but it deliberately does NOT touch contestant history.
 *  `ctf:quiz:answers:<login>` / `ctf:quiz:attempts:<login>` rows for the
 *  deleted id stay put, and the two aggregate counters
 *  (`ctf:quiz:points`/`ctf:quiz:answered`) are not decremented — so points
 *  already banked for this question REMAIN on the leaderboard. Clearing
 *  banked points is the master reset's job (admin-store's `resetEvent`),
 *  which wipes exactly those hashes across every login at once.
 *
 *  That's a deliberate contract, not an oversight: cascading a delete across
 *  every per-login hash plus aggregate decrements is a fan-out destructive
 *  write with no atomic story and no undo, and retiring a question is a far
 *  more common need than un-awarding points for it. Because the aggregates
 *  outlive the question, a login can hold more answers than the question
 *  list has entries — `leaderboard/module-contributions.ts` clamps the
 *  "answered / total" denominator for exactly that reason. */
export async function deleteQuestion(id: string): Promise<void> {
  if (!QUIZ_ID_RE.test(id)) throw new QuizValidationError("id", `Invalid question id: ${id}`);
  const results = await upstashPipeline([
    ["HDEL", QUESTIONS_KEY, id],
    ["HDEL", KEY_KEY, id],
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash HDEL failed: ${failed.error}`);
}

/** Deletes ONLY the content keys — questions and the answer key — never the
 *  run-state keys (points, answered, answers:&lt;login&gt;, attempts:&lt;login&gt;).
 *
 *  For a replace-all import: the caller wipes the bank clean before writing a
 *  fresh bundle over it, so a question dropped from the new bundle doesn't
 *  linger from the old one. Contestant history and aggregates are
 *  deliberately untouched, mirroring `deleteQuestion`'s contract — that is
 *  the master reset's job (admin-store's `resetEvent`), not this one's. */
export async function clearQuestions(): Promise<void> {
  const results = await upstashPipeline([
    ["DEL", QUESTIONS_KEY],
    ["DEL", KEY_KEY],
  ]);
  // This runs on the destructive replace-all path (event-store's
  // importEventBundle) — a silently-swallowed per-command error here would
  // leave stale content behind while the caller believes the bank is clean.
  // Same discipline as deleteQuestion above: surface it instead.
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash DEL failed: ${failed.error}`);
}

export type ViewerQuiz = {
  /** Correct answers only, keyed by question id. */
  answered: Record<string, { points: number; at: string }>;
  /** Every attempt (right or wrong), keyed by question id. */
  attempts: Record<string, { attempts: number; lastAt: string }>;
};

function parseHashEntries<T>(flat: unknown, extract: (parsed: Record<string, unknown>) => T | null): Record<string, T> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out: Record<string, T> = {};
  for (let i = 0; i < arr.length; i += 2) {
    try {
      const parsed = JSON.parse(arr[i + 1]) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      const value = extract(parsed as Record<string, unknown>);
      if (value !== null) out[arr[i]] = value;
    } catch {
      // Skip unparseable rows.
    }
  }
  return out;
}

function extractAnswered(v: Record<string, unknown>): { points: number; at: string } | null {
  if (typeof v.points !== "number" || typeof v.at !== "string") return null;
  return { points: v.points, at: v.at };
}

function extractAttempt(v: Record<string, unknown>): { attempts: number; lastAt: string } | null {
  if (typeof v.attempts !== "number" || typeof v.lastAt !== "string") return null;
  return { attempts: v.attempts, lastAt: v.lastAt };
}

/** A single caller's quiz progress: correct answers earned (points/at only —
 *  the stored record's `choices` is answer-shaped and stays out of the
 *  viewer-facing shape) and every attempt made. Never touches the answer key
 *  hash. */
export async function getViewerQuiz(login: string): Promise<ViewerQuiz> {
  const [answeredRes, attemptsRes] = await upstashPipeline([
    ["HGETALL", answersKey(login)],
    ["HGETALL", attemptsKey(login)],
  ]);
  return {
    answered: parseHashEntries(answeredRes.result, extractAnswered),
    attempts: parseHashEntries(attemptsRes.result, extractAttempt),
  };
}

/** Parses a single HGET reply (not a flat hash array) the same way
 *  `parseHashEntries` parses each row of one. */
function parseJsonValue<T>(raw: unknown, extract: (parsed: Record<string, unknown>) => T | null): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return extract(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** One login's (or one team's) quiz aggregate, as consumed by the leaderboard
 *  overlay (`leaderboard/module-contributions.ts`). */
/** `itemIds` is present only on the TEAM path, whose fold already dedupes by
 *  item id — the aggregate per-login path has running counters with no memory
 *  of which items produced them. Where it is present a caller can union it
 *  with the live catalogue for a denominator that survives an organizer
 *  deleting a solved item (#348); where it is absent the caller clamps, which
 *  is what every row did before. */
export type QuizTotal = { points: number; answered: number; lastAt: string | null; itemIds?: string[] };

function parseCounterHash(flat: unknown): Map<string, number> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const out = new Map<string, number>();
  for (let i = 0; i < arr.length; i += 2) {
    const n = Number(arr[i + 1]);
    if (Number.isFinite(n)) out.set(arr[i], n);
  }
  return out;
}

/** Per-login quiz totals for every login that has answered at least one
 *  question correctly — three `HGETALL`s in one pipeline (`ctf:quiz:points`,
 *  `ctf:quiz:answered`, `ctf:quiz:lastAt`), maintained atomically by
 *  GRADE_SCRIPT alongside the per-login answer row (see the header comment
 *  and GRADE_SCRIPT's own comment, step 6). The cost does not grow with the
 *  board, mirroring `getHintPenalties` in hint-store.ts.
 *
 *  `lastAt` is the login's latest award time (#522), the leaderboard's
 *  "whoever got there first" tiebreak. It is null for a login that last
 *  scored before the time was recorded, and for everyone when that read
 *  fails (`readLastAt` fails open: the points stand). */
export async function getQuizTotals(): Promise<Map<string, QuizTotal>> {
  const [pointsRes, answeredRes, lastAtRes] = await upstashPipeline([
    ["HGETALL", POINTS_KEY],
    ["HGETALL", ANSWERED_KEY],
    ["HGETALL", LAST_AT_KEY],
  ]);
  const points = parseCounterHash(pointsRes.result);
  const answered = parseCounterHash(answeredRes.result);
  const lastAt = readLastAt(lastAtRes, "quiz");

  const totals = new Map<string, QuizTotal>();
  for (const login of new Set([...points.keys(), ...answered.keys()])) {
    totals.set(login, { points: points.get(login) ?? 0, answered: answered.get(login) ?? 0, lastAt: lastAt.get(login) ?? null });
  }
  return totals;
}

/** Every team's quiz total in one round trip: one team's members per entry
 *  in `teams`, one `QuizTotal` per entry out, in the same order.
 *
 *  A TEAM's quiz total is the UNION of questions its members answered
 *  correctly (spec D6), never the sum of member aggregates — summing would
 *  double count any question two teammates both answered, which is exactly
 *  the double-count bug the per-login aggregate counters exist to avoid at
 *  the individual level. The aggregates can't serve a team: they're running
 *  totals with no memory of WHICH questions contributed to them, so there is
 *  no way to dedupe from them. Instead this reads each member's
 *  `ctf:quiz:answers:<login>` hash directly and dedupes by question id
 *  (`foldTeamAnswers`), keeping the EARLIEST correct answer's stored points
 *  for any question two or more members both hold (a later re-answer by a
 *  teammate — or a since-changed question price recorded on someone else's
 *  row — never changes what the team already earned). Teams are capped at a
 *  handful of members, so one HGETALL per member is cheap.
 *
 *  Batched because `/leaderboard` is dynamic and fetched `no-store`: a
 *  per-team form cost a 25-team event 25 REST calls on every single page
 *  view; this is exactly ONE `upstashPipeline` round trip for the whole
 *  board. A login on two teams is fetched once and its replies reused for
 *  both, so the pipeline carries one `HGETALL` per DISTINCT member. There is
 *  no single-team wrapper any more — the one that existed had no caller but
 *  its own test; a single team is `getTeamQuizTotalsBatch([members])`. */
export async function getTeamQuizTotalsBatch(teams: readonly (readonly string[])[]): Promise<QuizTotal[]> {
  const indexByLogin = new Map<string, number>();
  for (const members of teams) {
    for (const login of members) {
      if (!indexByLogin.has(login)) indexByLogin.set(login, indexByLogin.size);
    }
  }
  const logins = [...indexByLogin.keys()];
  if (logins.length === 0) return teams.map(() => ({ points: 0, answered: 0, lastAt: null, itemIds: [] }));

  const results = await upstashPipeline(logins.map((login) => ["HGETALL", answersKey(login)]));
  return teams.map((members) => foldTeamAnswers(members.map((login) => results[indexByLogin.get(login) ?? -1])));
}

/** The union-by-question fold both team forms share. Keeps the EARLIEST
 *  correct answer for any question more than one member holds — a later
 *  re-answer by a teammate, or a since-changed price recorded on someone
 *  else's row, never changes what the team already earned.
 *
 *  The rule itself lives in `leaderboard/team-fold.ts` and is shared verbatim
 *  with classic-store's team fold: the two are structurally identical (dedupe
 *  by hash field, earliest wins, sum points, latest timestamp), and two
 *  near-identical copies of a scoring rule drifting apart is exactly the
 *  failure mode this repo keeps its lockstep rule for. All this wrapper does
 *  is rename the shared `completed` to quiz's own noun. */
function foldTeamAnswers(memberReplies: ({ result?: unknown; error?: string } | undefined)[]): QuizTotal {
  const { points, completed, lastAt, itemIds } = foldTeamItems(memberReplies);
  return { points, answered: completed, lastAt, itemIds };
}

export type QuizGate =
  | { allowed: true }
  | {
      allowed: false;
      reason: "paused" | "answered" | "exhausted" | "cooldown" | "unavailable";
      retryAt?: string;
      attemptsLeft?: number;
    };

type ResolvedAdminSettings = Awaited<ReturnType<typeof getAdminSettings>>;

/** The gate logic, factored out so `answerQuestion` can reuse a settings
 *  object it already fetched instead of hitting `ctf:admin:settings` a
 *  second time. `quizGate` (below) is the public, settings-fetching form —
 *  used standalone (e.g. a status check before the caller has even chosen an
 *  answer) and internally as the CHEAP pre-check `answerQuestion` runs
 *  before ever calling the grading script.
 *
 *  IMPORTANT: this pre-check is NOT the authority on the attempt cap or the
 *  cooldown — it reads attempts/answers with its own separate, non-atomic
 *  round trip, so two requests racing each other can both read "0 attempts
 *  spent" before either has written anything. It exists only to keep an
 *  obviously-refused answer off the write path cheaply; GRADE_SCRIPT
 *  re-checks both, against state read fresh at script-execution time, and
 *  is what actually enforces them (see GRADE_SCRIPT's comment). */
async function evaluateGate(
  settings: ResolvedAdminSettings | null,
  login: string,
  questionId: string,
  dryRun = false,
): Promise<QuizGate> {
  // `settings` is null when the settings read itself failed — the pause/
  // schedule check then fails OPEN (a null reads as "not paused"), matching
  // classic-store's gate and the manual-freeze fail-open in scorer and sync.
  // A dry run (#464 admin preview) happens exactly while scoring is closed —
  // before launch — so the pause is what is being previewed, not a refusal.
  if (!dryRun && settings && effectivePaused(settings)) return { allowed: false, reason: "paused" };

  const maxAttempts = settings?.quizMaxAttempts ?? QUIZ_MAX_ATTEMPTS;
  const retryAfterMin = settings?.quizRetryAfterMin ?? QUIZ_RETRY_AFTER_MIN;

  let answered: { points: number; at: string } | null;
  let attempt: { attempts: number; lastAt: string } | null;
  try {
    const [answeredRes, attemptRes] = await upstashPipeline([
      ["HGET", answersKey(login), questionId],
      ["HGET", attemptsKey(login), questionId],
    ]);
    if (answeredRes.error) throw new Error(answeredRes.error);
    if (attemptRes.error) throw new Error(attemptRes.error);
    answered = parseJsonValue(answeredRes.result, extractAnswered);
    attempt = parseJsonValue(attemptRes.result, extractAttempt);
  } catch (err) {
    console.error("quiz gate: attempt/answer lookup failed:", errorLabel(err));
    return { allowed: false, reason: "unavailable" };
  }

  if (answered) return { allowed: false, reason: "answered" };
  // Nothing a dry run does is recorded: no budget is spent, nothing cools.
  if (dryRun) return { allowed: true };

  const attemptsSoFar = attempt?.attempts ?? 0;
  if (maxAttempts > 0 && attemptsSoFar >= maxAttempts) {
    return { allowed: false, reason: "exhausted", attemptsLeft: 0 };
  }

  if (retryAfterMin > 0 && attempt) {
    const lastMs = Date.parse(attempt.lastAt);
    if (Number.isFinite(lastMs)) {
      const retryAtMs = lastMs + retryAfterMin * 60_000;
      if (Date.now() < retryAtMs) {
        return { allowed: false, reason: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
      }
    }
  }

  return { allowed: true };
}

/** Decides whether `login` may submit a graded answer for `questionId` right
 *  now. Checked in this order (each one short-circuits the rest):
 *    1. scoring paused, or outside the scheduled scoring window
 *    2. `login` already holds a correct answer for this question
 *    3. `login` has spent every attempt `quizMaxAttempts` allows
 *    4. `login` is still inside the `quizRetryAfterMin` cooldown since its
 *       last attempt
 *
 *  `retryAt` (cooldown reason) is DERIVED from `lastAt + quizRetryAfterMin`
 *  on every call, never stored — so lowering the cooldown mid-event lifts a
 *  lock immediately instead of leaving it stale until some persisted
 *  unlock time catches up.
 *
 *  Fails CLOSED: if the attempt/answer lookup itself errors, this refuses
 *  the answer with its own distinct reason, "unavailable" — deliberately
 *  NOT "exhausted", because misreporting an unverifiable lookup as a real
 *  attempt-count fact (telling a contestant who has used zero attempts that
 *  they have none left) turns a transient Redis blip into a support
 *  conversation about a wrong count. This is the OPPOSITE of the scoring
 *  freeze (`effectivePaused`), which fails OPEN so a Redis blip never drops
 *  a live submission — a failed SETTINGS read therefore treats scoring as
 *  live and falls back to the baked cap/cooldown, exactly like
 *  classic-store's gate. Here, the safe failure is "no attempt", not "grade
 *  a possibly-replayed answer", but the caller must still be told the truth:
 *  the check couldn't be completed, not that they're out of attempts.
 *
 *  This function is a cheap, non-atomic pre-check — see the note on
 *  `evaluateGate` above about why it is NOT what actually enforces the cap
 *  or cooldown against a race. */
export async function quizGate(login: string, questionId: string): Promise<QuizGate> {
  return evaluateGate(await readSettingsFailOpen(), login, questionId);
}

/** Fails OPEN: if the settings read blows up we treat scoring as live rather
 *  than dropping a submission a contestant is entitled to make. The cap and
 *  cooldown then fall back to the module defaults, which GRADE_SCRIPT still
 *  enforces. Mirrors classic-store's submitFlag. */
async function readSettingsFailOpen(): Promise<ResolvedAdminSettings | null> {
  try {
    return await getAdminSettings();
  } catch (err) {
    console.error("quiz: admin settings read failed, treating scoring as live:", errorLabel(err));
    return null;
  }
}

// Grades one submission and, on success, records everything it changes in a
// single atomic operation — mirroring hint-store.ts's REVEAL_SCRIPT, whose
// SADD-return-value idempotency guard is the pattern copied here as an
// HEXISTS guard. Unlike the JS-side `quizGate`/`evaluateGate` pre-check
// (which reads attempts/answers over its own separate, non-atomic round
// trip and so CANNOT by itself stop two — or fifteen — concurrent requests
// from all observing "0 attempts spent" before any of them writes), this
// script is the sole AUTHORITY on the attempt cap and cooldown: it re-reads
// attempts fresh at execution time, and Redis runs one script to completion
// before starting the next, so each concurrent submission sees every effect
// of every submission that finished before it. That's what actually closes
// the race — no amount of care in the pre-check could, since the pre-check
// and the script are necessarily two separate round trips.
//
//   1. HGET the secret answer key for this question. Missing -> {'missing'}:
//      there is nothing to grade (the caller passed a bad/deleted id).
//   2. HEXISTS on the per-login answers hash for this question, BEFORE any
//      write. A hit means `login` already banked a correct answer here (a
//      race that slipped past the gate's own read) -> {'already'}, with
//      nothing else touched.
//   3. Read the current {attempts,lastAt,lastAtMs} blob (plain string
//      matching, not a JSON library — the field format is one this module
//      fully controls) and, WITHOUT WRITING ANYTHING YET, re-check the cap
//      and cooldown against ARGV-supplied `maxAttempts`/`cooldownMs` (the
//      admin setting, resolved by the caller from the CURRENT config on
//      every call — never stored) and the freshly-read `attempts`/`lastAtMs`
//      (never a value the caller read earlier and handed in, which is what
//      would let a race bypass them):
//        - `attempts >= maxAttempts` (when capped) -> {'exhausted'}
//        - still within `lastAtMs + cooldownMs` (when cooled down) ->
//          {'cooldown', retryAtMs}
//   4. Only past both checks does a submission spend an attempt: bump the
//      count and HSET the new blob with `now`. This happens whether the
//      submission turns out right or wrong.
//   5. Compare the submitted sorted-JSON-array string against the stored
//      key, byte for byte (both sides are produced by the same
//      `[...ids].sort()` + `JSON.stringify` recipe — see `upsertQuestion`'s
//      dedupe-then-sort and `answerQuestion`'s dedupe-then-sort below, which
//      must keep agreeing for this comparison to mean anything — so equal
//      sets serialize identically regardless of submission order). Not
//      equal -> {'incorrect'}.
//   6. Equal: HGET the question's current `points` (read at grading time,
//      per spec, rather than trusting a value the caller might have fetched
//      earlier; `upsertQuestion` requires `points` to be a non-negative
//      integer so this match — and the HINCRBY below — can't be handed a
//      decimal mid-script with no way to roll back), HSET the answer row,
//      and HINCRBY the two aggregate counters (`ctf:quiz:points`,
//      `ctf:quiz:answered`) that the leaderboard overlay reads later ->
//      {'correct', points}.
//
// Both pattern matches are anchored with a trailing `[,}]` so a value can
// only match a complete `"field":<value>` pair immediately followed by the
// next field or the closing brace — not an arbitrary digit run that happens
// to appear earlier in the blob (e.g. inside a differently-ordered field).
export const GRADE_SCRIPT = `
local key = redis.call('HGET', KEYS[3], ARGV[1])
if not key then return {'missing'} end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return {'already'} end

local maxAttempts = tonumber(ARGV[5])
local cooldownMs = tonumber(ARGV[6])
local nowMs = tonumber(ARGV[7])
-- DRY RUN (#464 admin preview): grade, write NOTHING, ignore the attempt
-- budget and cooldown (nothing is recorded, so neither is being spent).
local dry = ARGV[8] == '1'

local attemptsRaw = redis.call('HGET', KEYS[1], ARGV[1])
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
end

if not dry and maxAttempts > 0 and attempts >= maxAttempts then
  return {'exhausted'}
end
if not dry and cooldownMs > 0 and lastAtMs and nowMs < (lastAtMs + cooldownMs) then
  return {'cooldown', tostring(lastAtMs + cooldownMs)}
end

attempts = attempts + 1
if not firstAt then firstAt = ARGV[3] end
if not dry then
  redis.call('HSET', KEYS[1], ARGV[1], '{"attempts":' .. attempts .. ',"firstAt":"' .. firstAt .. '","lastAt":"' .. ARGV[3] .. '","lastAtMs":' .. ARGV[7] .. '}')
end

if key ~= ARGV[2] then
  if dry then return {'incorrect', '0', 'dry'} end
  return {'incorrect', tostring(attempts)}
end

local qRaw = redis.call('HGET', KEYS[4], ARGV[1])
local points = 0
if qRaw then
  local found = string.match(qRaw, '"points":(%-?%d+)[,}]')
  if found then points = tonumber(found) end
end
if dry then return {'correct', tostring(points), 'dry'} end
redis.call('HSET', KEYS[2], ARGV[1], '{"choices":' .. ARGV[2] .. ',"points":' .. points .. ',"at":"' .. ARGV[3] .. '"}')
redis.call('HINCRBY', KEYS[5], ARGV[4], points)
redis.call('HINCRBY', KEYS[6], ARGV[4], 1)
-- Keep the LATEST award time (#522). The time is taken before this script
-- runs, so two awards can arrive out of order; toISOString values compare
-- correctly as strings. A stored value that is not an ISO time is replaced.
local prevAt = redis.call('HGET', KEYS[7], ARGV[4])
if not prevAt or not string.match(prevAt, '^%d%d%d%d%-%d%d%-%d%dT') or prevAt < ARGV[3] then
  redis.call('HSET', KEYS[7], ARGV[4], ARGV[3])
end
return {'correct', tostring(points)}`;

export type AnswerResult =
  // `already` marks the idempotent re-submission of a question this login
  // had ALREADY banked (GRADE_SCRIPT's step-2 guard). It is still a correct
  // answer, but `points` is 0 because this call awarded nothing further —
  // NOT because the question is worth nothing. Callers must render the two
  // apart; "Correct — +0 points." is exactly the wrong thing to say here.
  // `dryRun`: an admin-preview grade (#464) — nothing was written.
  | { ok: true; correct: true; points: number; already?: boolean; dryRun?: true }
  | { ok: true; correct: false; dryRun?: true }
  | { ok: false; reason: "paused" | "answered" | "exhausted" | "cooldown"; retryAt?: string }
  // The gate's lookup itself failed (fail-closed) — kept distinct from
  // "exhausted" so a caller-facing message can say the check couldn't be
  // completed (try again) instead of falsely claiming attempts are spent.
  | { ok: false; reason: "unavailable" }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "error" };

/** Grades `choices` against `questionId` for `login`. All-or-nothing: the
 *  submitted set must equal the correct set exactly, order-insensitive — a
 *  partial set or a superset scores 0 (and still spends an attempt), the
 *  same as any other wrong answer. Single-choice is simply the one-element
 *  case of this same rule, not a separate path.
 *
 *  The retry gate (`quizGate`/`evaluateGate`) is checked BEFORE the grading
 *  script runs — a refused answer must never reach Redis's scoring path —
 *  but it is only a cheap pre-check; GRADE_SCRIPT re-checks the same cap and
 *  cooldown authoritatively (see its comment) using the current admin
 *  settings resolved by THIS call, so a race that slips past the pre-check
 *  is still caught, atomically, by the script. This function never returns
 *  the answer key itself, only whether the submission was right. */
export async function answerQuestion(
  login: string,
  questionId: string,
  choices: string[],
  opts: { dryRun?: boolean } = {},
): Promise<AnswerResult> {
  const dryRun = opts.dryRun === true;
  if (!QUIZ_ID_RE.test(questionId)) return { ok: false, reason: "invalid" };
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    !choices.every((c) => typeof c === "string" && QUIZ_ID_RE.test(c))
  ) {
    return { ok: false, reason: "invalid" };
  }

  const settings = await readSettingsFailOpen();
  const gate = await evaluateGate(settings, login, questionId, dryRun);
  if (!gate.allowed) {
    // Kept as its own branch (not folded into the passthrough below) so its
    // caller-facing shape can never accidentally pick up a retryAt/attempts
    // fact the lookup never actually established.
    if (gate.reason === "unavailable") return { ok: false, reason: "unavailable" };
    return gate.retryAt
      ? { ok: false, reason: gate.reason, retryAt: gate.retryAt }
      : { ok: false, reason: gate.reason };
  }

  // Order-insensitive: the same shared `canonicalizeChoices` recipe
  // `upsertQuestion` stores the correct set with, so an exact JSON-string
  // match inside the script is a valid stand-in for a set comparison.
  const submitted = JSON.stringify(canonicalizeChoices(choices));
  const now = new Date();
  const nowIso = now.toISOString();

  // Recomputed from the SAME settings the pre-check just used (never a
  // stored cutoff) and handed to the script as plain numbers — the script
  // combines them with the attempts row IT reads at execution time, so the
  // authoritative check is never working from data this call read earlier.
  const maxAttempts = settings?.quizMaxAttempts ?? QUIZ_MAX_ATTEMPTS;
  const cooldownMs = (settings?.quizRetryAfterMin ?? QUIZ_RETRY_AFTER_MIN) * 60_000;

  let verdict: unknown;
  try {
    verdict = await upstashEval(
      GRADE_SCRIPT,
      [attemptsKey(login), answersKey(login), KEY_KEY, QUESTIONS_KEY, POINTS_KEY, ANSWERED_KEY, LAST_AT_KEY],
      // ARGV[8]: dry run — grade, write nothing (#464 admin preview).
      [questionId, submitted, nowIso, login, maxAttempts, cooldownMs, now.getTime(), dryRun ? "1" : "0"],
    );
  } catch (err) {
    console.error("Quiz grading failed:", errorLabel(err));
    return { ok: false, reason: "error" };
  }

  const [status, value, marker] = Array.isArray(verdict) ? (verdict as unknown[]) : [];
  if (status === "missing") return { ok: false, reason: "invalid" };
  // A dry verdict carries a trailing 'dry' from the script itself, so a
  // preview result can never be read as a banked answer.
  if (marker === "dry") {
    if (status === "correct") return { ok: true, correct: true, points: Number(value) || 0, dryRun: true };
    if (status === "incorrect") return { ok: true, correct: false, dryRun: true };
    return { ok: false, reason: "error" };
  }
  if (status === "exhausted") return { ok: false, reason: "exhausted" };
  if (status === "cooldown") {
    const retryAtMs = Number(value);
    return { ok: false, reason: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
  }
  if (status === "incorrect") return { ok: true, correct: false };
  // Raced a prior correct submission past the gate's own read — already
  // banked, so this call awards nothing further, but it IS a correct answer.
  // `already` is what lets the caller say "you already had this one" rather
  // than announcing a literal award of zero points.
  if (status === "already") return { ok: true, correct: true, points: 0, already: true };
  if (status === "correct") return { ok: true, correct: true, points: Number(value) || 0 };
  return { ok: false, reason: "error" };
}
