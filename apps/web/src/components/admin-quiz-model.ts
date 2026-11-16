// The quiz admin panel's pure model: the draft/editor/payload types, the
// validation and payload builders, the delete-confirmation copy, the bundle
// export and the row accessors — everything about a question the panel
// reasons about without rendering or fetching. Split out of
// admin-quiz-controls.tsx (which re-exports all of it) so the component file
// stays readable; see that file's header for the design notes these helpers
// implement (generated ids, order from list position, the answer key held
// deliberately, what deletion does and does not do).

import type { AdminQuestion, Choice, Question, QuestionType, QuizImportSummary } from "@/lib/quiz-store";
import { generateQuestionId } from "@/lib/quiz-keys";
import { QUIZ_BUNDLE_VERSION, type QuizBundle } from "@/lib/quiz-io";
import type { ModuleInventory } from "@/components/admin-module-setup";
import { describeAdminError } from "@/components/admin/fetch";
import { DELETE_CONFIRM_PHRASE_MAX, confirmPhrase } from "@/components/admin/confirm-phrase";
import { type RowAccessors, changedOrderRows as changedRows, reorderRows } from "@/components/admin/ordered-rows";

/** What this panel tells the shell about its content. Pure, so the shape is
 *  provable without running the effect that sends it. Exported for direct
 *  testing. */
export function quizInventory(rows: readonly AdminQuestion[]): ModuleInventory {
  return { items: rows.length };
}

/** Maps a `/api/admin/quiz` response to a message that tells a validation
 *  failure (the organizer's payload was bad — 400) apart from an
 *  infrastructure failure (the store itself is unavailable — 503), so an
 *  organizer is never told "bad request" for a problem that was never
 *  theirs to fix. Exported for direct testing. */
export function describeQuizError(status: number, message?: string): string {
  return describeAdminError(status, message, "That didn't work — check the question and try again.");
}

export { DELETE_CONFIRM_PHRASE_MAX };

/** The exact string the delete confirmation makes the organizer type: the
 *  question's prompt, through the shared `confirmPhrase` (whitespace-collapsed,
 *  cut at a word boundary inside `DELETE_CONFIRM_PHRASE_MAX`). No fallback:
 *  a prompt is required non-empty, so there is nothing to fall back from.
 *  Exported for direct testing. */
export function confirmPhraseFromPrompt(prompt: string): string {
  return confirmPhrase(prompt);
}

/** The exact copy + gating for the delete confirmation.
 *
 *  The phrase is the question's PROMPT, not its id. The id used to be typed
 *  here, back when an organizer chose it; now it is generated
 *  (`generateQuestionId`), and asking someone to transcribe
 *  "which-header-mitigates-cl-k3f9qa" proves only that they can copy a string
 *  — it doesn't make them read WHICH question they are about to remove, which
 *  is the entire job of this gate. The prompt does.
 *
 *  The id still appears in `body`, as a fact rather than a task: two questions
 *  whose prompts share a first 48 characters would ask for the same phrase, and
 *  the id is what tells them apart on screen. (Which one actually goes is never
 *  in doubt — the delete is dispatched against the selected row's id, not
 *  against anything typed.)
 *
 *  `body` states the real contract, which is narrower than it looks: the
 *  question goes away, banked points do not. Saying otherwise (an earlier
 *  draft claimed it "permanently destroys every contestant's answer and
 *  attempt history") would send an organizer trying to un-award points down
 *  a path that doesn't do that — the master reset is what does. Exported for
 *  direct testing. */
export function questionDeleteConfirm(question: Question): {
  title: string;
  body: string;
  requireType: string;
  confirmLabel: string;
} {
  const phrase = confirmPhraseFromPrompt(question.prompt);
  return {
    title: `Delete "${phrase}"?`,
    body:
      `This removes the question (id ${question.id}) from the quiz and hides it from contestants. ` +
      "Points already banked for it stay on the leaderboard — to clear those, use the master reset.",
    requireType: phrase,
    confirmLabel: "Delete question",
  };
}

export type ChoiceDraft = Choice;

/** Everything about a question that the FORM may change.
 *
 *  Deliberately missing: `id` and `order`. Both are storage plumbing derived
 *  elsewhere (`QuestionEditor` below holds them), and their absence here is
 *  what makes "an edit cannot change a question's id" a property of the types
 *  rather than of a `disabled` attribute somebody could remove. */
export type QuestionDraft = {
  prompt: string;
  type: QuestionType;
  points: string;
  choices: ChoiceDraft[];
  correct: string[];
};

/** The form's whole state: the editable draft plus the identity/position the
 *  form does not own.
 *
 *  A discriminated union rather than `{ id?: string }`, so the id is reachable
 *  only after establishing which case you are in — a NEW question genuinely
 *  has no id yet (it is minted from the prompt at save time), and an EXISTING
 *  one's is fixed. */
export type QuestionEditor =
  | { mode: "new"; order: number; draft: QuestionDraft }
  | { mode: "edit"; id: string; order: number; draft: QuestionDraft };

/** The POST body `/api/admin/quiz` parses. Mirrors that route's
 *  `QuestionPayload` — the route re-validates every field, this type just
 *  keeps the client from assembling something obviously wrong. */
export type QuestionPayload = {
  id: string;
  prompt: string;
  type: QuestionType;
  choices: Choice[];
  points: number;
  order: number;
  correct: string[];
};

export function emptyDraft(): QuestionDraft {
  return {
    prompt: "",
    type: "single",
    points: "10",
    choices: [
      { id: "a", label: "" },
      { id: "b", label: "" },
    ],
    correct: [],
  };
}

/** A brand-new question, positioned at the end of the list. No id: one is
 *  generated from the finished prompt when the draft is submitted, so the
 *  slug reflects what the organizer actually typed rather than whatever the
 *  prompt field held at the moment they clicked "Add question". */
export function newQuestionEditor(nextOrder: number): QuestionEditor {
  return { mode: "new", order: nextOrder, draft: emptyDraft() };
}

/** Seeds an edit draft from an existing question — INCLUDING the choices
 *  currently marked correct, which is the whole point of taking an
 *  `AdminQuestion` here rather than a bare `Question`. Starting a typo fix
 *  with nothing selected made re-picking the answer from memory a required
 *  step of every save, and a wrong guess there silently changed what counts
 *  as correct for every contestant.
 *
 *  `correct` is copied, never aliased: the draft is edited in place as the
 *  organizer toggles choices, and mutating the list row behind it would make
 *  a cancelled edit look saved. */
export function draftFromQuestion({ question: q, correct }: AdminQuestion): QuestionDraft {
  return {
    prompt: q.prompt,
    type: q.type,
    points: String(q.points),
    choices: q.choices.map((c) => ({ ...c })),
    correct: [...correct],
  };
}

/** Opens an existing question for editing: its draft, plus the id and order
 *  the form cannot touch. */
export function editorFromQuestion(row: AdminQuestion): QuestionEditor {
  return { mode: "edit", id: row.question.id, order: row.question.order, draft: draftFromQuestion(row) };
}

/** Whether `draft` could be submitted as-is. Mirrors the store's own rules
 *  (a `"single"` question needs exactly one correct choice) PLUS basic form
 *  hygiene (non-empty fields, at least two choices, unique choice ids) so an
 *  organizer can't build something the store would reject and only find out
 *  on submit (Requirement 4).
 *
 *  No id check any more, and that is not an oversight: a new question's id is
 *  derived from the prompt (which IS checked non-empty) and an existing one's
 *  is fixed, so there is no id for a draft to get wrong. Same for order, which
 *  now comes from list position. Exported for direct testing. */
export function isDraftValid(d: QuestionDraft): boolean {
  if (d.prompt.trim().length === 0) return false;

  const points = Number(d.points);
  if (d.points.trim() === "" || !Number.isInteger(points) || points < 0) return false;

  if (d.choices.length < 2) return false;
  const ids = new Set<string>();
  for (const c of d.choices) {
    const id = c.id.trim();
    const label = c.label.trim();
    if (id.length === 0 || label.length === 0) return false;
    if (ids.has(id)) return false;
    ids.add(id);
  }

  // Trimmed on both sides, exactly as `payloadFromEditor` does: `ids` already
  // holds trimmed choice ids, so comparing a raw `correct` entry against them
  // made " a " count as no selection here while the payload sent "a". The gate
  // and the body have to agree about what a selection is, or one of them is
  // lying to the organizer.
  const correct = d.correct.map((id) => id.trim()).filter((id) => ids.has(id));
  if (d.type === "single" && correct.length !== 1) return false;
  if (d.type === "multi" && correct.length < 1) return false;

  return true;
}

/** The POST body for an editor's current state.
 *
 *  The id rule is the whole reason this is a function and not an inline object
 *  literal at the call site: on `mode: "edit"` it is `editor.id`, full stop —
 *  no derivation from the (possibly just-rewritten) prompt, because changing
 *  an id would orphan every answer already recorded against the old one. On
 *  `mode: "new"` it is minted from the prompt.
 *
 *  `correct` is trimmed and filtered against the choices actually being sent,
 *  because the draft's copy outlives a rename: an organizer who retitles
 *  choice `a` to `option-a` leaves `"a"` in `draft.correct`, and the route
 *  400s on a `correct` entry naming no choice. `isDraftValid` has always
 *  applied this same filter before counting, so without it here the panel
 *  could enable Save on a draft whose payload the route then refused (#280).
 *
 *  `newId` is injectable so a test can pin the generated value; production
 *  always uses `generateQuestionId`, whose output is checked against the
 *  store's own `QUIZ_ID_RE` before it is returned. Exported for direct
 *  testing. */
export function payloadFromEditor(
  editor: QuestionEditor,
  newId: (prompt: string) => string = generateQuestionId,
): QuestionPayload {
  const d = editor.draft;
  const prompt = d.prompt.trim();
  const choices = d.choices.map((c) => ({ id: c.id.trim(), label: c.label.trim() }));
  const choiceIds = new Set(choices.map((c) => c.id));
  return {
    id: editor.mode === "edit" ? editor.id : newId(prompt),
    prompt,
    type: d.type,
    choices,
    points: Number(d.points),
    order: editor.order,
    correct: d.correct.map((id) => id.trim()).filter((id) => choiceIds.has(id)),
  };
}

/** The POST body that re-saves an existing row unchanged apart from whatever
 *  the caller already rewrote on it — used by the reorder path, which changes
 *  `order` and nothing else. Goes through the same endpoint (and therefore
 *  the same validation and audit line) as an edit. */
export function payloadFromRow({ question: q, correct }: AdminQuestion): QuestionPayload {
  return {
    id: q.id,
    prompt: q.prompt,
    type: q.type,
    choices: q.choices.map((c) => ({ ...c })),
    points: q.points,
    order: q.order,
    correct: [...correct],
  };
}

/** Where a quiz row keeps its id and position — the one thing that
 *  distinguishes this panel's list arithmetic from classic's (see
 *  components/admin/ordered-rows.ts). */
export const QUESTION_ROWS: RowAccessors<AdminQuestion> = {
  id: (row) => row.question.id,
  order: (row) => row.question.order,
  withOrder: (row, order) => ({ ...row, question: { ...row.question, order } }),
};

/** Moves the row at `from` to index `to` and rewrites EVERY row's `order`
 *  from its new position (1-based) — the shared `reorderRows` over quiz rows.
 *  Pure and exported so the drag handlers and Move up/down buttons only ever
 *  work out a pair of indices (see the shared module's header for why). */
export function reorderQuestions(list: readonly AdminQuestion[], from: number, to: number): AdminQuestion[] {
  return reorderRows(list, from, to, QUESTION_ROWS);
}

/** The rows whose `order` differs between two versions of the list — exactly
 *  the questions a reorder has to write back. Matched by question id. */
export function changedOrderRows(before: readonly AdminQuestion[], after: readonly AdminQuestion[]): AdminQuestion[] {
  return changedRows(before, after, QUESTION_ROWS);
}

/** Builds a bundle from the question bank this component already holds, so
 *  the export button's handler is a thin binding around a pure function —
 *  the same shape `payloadFromEditor`/`reorderQuestions` are pure for the
 *  same reason: `renderToStaticMarkup` cannot exercise a click handler, so
 *  the logic worth testing has to live outside one. Mirrors `exportBundle`
 *  in quiz-store.ts field for field (that one reads the store server-side;
 *  this one reads client state), so an export built here round-trips through
 *  `parseBundle` exactly like a server-side export would. Exported for
 *  direct testing. */
export function exportBundleFrom(rows: readonly AdminQuestion[]): QuizBundle {
  return {
    version: QUIZ_BUNDLE_VERSION,
    questions: rows.map(({ question: q, correct }) => ({
      id: q.id,
      prompt: q.prompt,
      type: q.type,
      choices: q.choices.map((c) => ({ id: c.id, label: c.label })),
      points: q.points,
      order: q.order,
      correct,
    })),
  };
}

/** Formats a `QuizImportSummary` into the panel's after-import message. Pure
 *  for the same reason `exportBundleFrom` just above is: `importResult` is
 *  `useState`, which `renderToStaticMarkup` can never reach, so the
 *  pluralization branch has to live outside a render tree to be exercised by
 *  a test at all. Exported for direct testing. */
export function formatImportSummary({ created, updated }: QuizImportSummary): string {
  const total = created + updated;
  const questionWord = total === 1 ? "question" : "questions";
  return `Imported ${total} ${questionWord}: ${created} created, ${updated} updated.`;
}
