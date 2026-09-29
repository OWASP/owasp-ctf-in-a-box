"use client";

// The Quiz module's admin section: the two retry-gate settings (max attempts,
// retry cooldown) plus full question authoring (add/edit/reorder/delete),
// rendered in place of admin-controls.tsx's old "No settings for this module
// yet." placeholder for the quiz module.
//
// Settings: the numeric inputs reuse `commitNumber` from admin-controls.tsx
// (passed down as a prop, already bound to that component's `settings`/`apply`
// state) — same pattern as the Secure Development hint knobs, not a second
// copy of the same plumbing.
//
// Questions: this component owns its own fetch of GET /api/admin/quiz and its
// own add/edit/reorder/delete state, independent of the settings machinery
// above. `initialQuestions` seeds the list synchronously (used by tests, which
// render with `renderToStaticMarkup` and so never run the mount-time fetch
// below); in the browser it's just the pre-hydration paint, immediately
// replaced by a fresh fetch.
//
// Two authoring fields an organizer used to have to type are now derived, and
// both for the same reason: they were storage plumbing wearing a text input.
//
//   - The question ID is generated from the prompt (`generateQuestionId`, in
//     quiz-keys.ts) when a NEW question is saved. It is the field name in
//     `ctf:quiz:questions` and `ctf:quiz:key` AND the reference every
//     contestant's `ctf:quiz:answers:<login>` row is recorded against, so on an
//     EXISTING question it is immutable: changing it would orphan every answer
//     already banked against the old one, leaving the points on the
//     leaderboard with no question to explain them. That immutability is
//     structural here, not a disabled input: `QuestionDraft` — the thing the
//     form edits — has NO id field at all. The id lives on `QuestionEditor`,
//     which the form never writes to, so `onChange({ ...draft, id })` is not
//     something a future edit to `QuestionForm` can even type.
//   - The ORDER is written from list position. Organizers drag rows (or use
//     the per-row Move up/Move down buttons, which is the keyboard-operable
//     path — drag alone is not operable for everyone, and this is an
//     organizer's control surface). `reorderQuestions` recomputes `order` from
//     the resulting positions and the changed rows are POSTed back. Storage is
//     unchanged: `listQuestions` still sorts by `order`.
//
// Secrecy: this component DOES hold the answer key, and that is deliberate.
// `GET /api/admin/quiz` is behind `requireAdmin` and returns
// `listQuestionsForAdmin()`'s output — one `AdminQuestion` (`{ question,
// correct }`) per question — so opening an existing question for editing
// prefills the choices currently marked correct. The alternative, which this
// component used to implement, was worse than the leak it avoided: an
// organizer fixing a typo in a prompt had to re-pick the answer from memory,
// and getting it wrong silently redefined what counts as correct for every
// contestant, with no diff and no warning. Anyone through the admin gate can
// already delete the question or rewrite its answer outright, so withholding
// the key here bought nothing.
//
// What has NOT changed: the contestant path is keyless, absolutely. `/quiz`
// calls `listQuestions()`, which never reads `ctf:quiz:key`, and builds its
// view model field by field from the public `Question` shape. `AdminQuestion`
// is deliberately NOT assignable to `Question` (see quiz-store.ts), so a
// record from this component cannot be handed to a contestant-facing
// component by mistake — it's a compile error, not a code-review catch.
//
// Deletion changes live event data mid-flight — the question disappears
// from every contestant's board and can no longer be answered — so it is
// gated behind the same `ConfirmModal` + `requireType` pattern the master
// reset uses: Confirm stays disabled until the organizer types the
// question's own PROMPT (see `questionDeleteConfirm`).
//
// What deletion does NOT do: it does not clear contestant history. Points
// already banked for the question stay on the leaderboard, because
// `deleteQuestion` removes only the question and its answer key (see its
// doc comment in quiz-store.ts — that contract is deliberate). Clearing
// banked points is the master reset's job. The confirm copy below says so
// in as many words; keep the two in step.

//
// The pure model (types, validation, payload builders, confirmation copy) is
// in admin-quiz-model.ts and the form in admin-quiz-form.tsx; both are
// re-exported here so tests and callers keep one import path.

import { useEffect } from "react";
import { QUIZ_MAX_ATTEMPTS, QUIZ_RETRY_AFTER_MIN } from "@/lib/quiz-defaults";
import type { AdminQuestion, Question, QuizImportSummary } from "@/lib/quiz-store";
import { parseBundle, serializeBundle } from "@/lib/quiz-io";
import ConfirmDelete from "@/components/admin/confirm-delete";
import DiscardDraftConfirm from "@/components/admin/discard-draft-confirm";
import ImportPanel from "@/components/admin/import-panel";
import { downloadJson, useBundleImport } from "@/components/admin/use-bundle-import";
import SortableList from "@/components/admin/sortable-list";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import type { ModuleInventory } from "@/components/admin-module-setup";
import AdminNumberField, { type FieldStatus } from "@/components/admin-number-field";
import AdminSettingsCard, { type ModuleSettingsSlot } from "@/components/admin/settings-card";
import QuestionForm from "@/components/admin-quiz-form";
import {
  QUESTION_ROWS,
  type QuestionEditor,
  type QuestionPayload,
  describeQuizError,
  editorFromQuestion,
  exportBundleFrom,
  formatImportSummary,
  newQuestionEditor,
  payloadFromEditor,
  payloadFromRow,
  questionDeleteConfirm,
  quizInventory,
} from "@/components/admin-quiz-model";

export * from "@/components/admin-quiz-model";

type NumericSettingKey = "quizMaxAttempts" | "quizRetryAfterMin";

export type AdminQuizControlsProps = {
  /** Parent-wide "a settings POST is in flight" flag — shared with every
   *  other section's inputs, same as the hint knobs. */
  pending: boolean;
  quizMaxAttemptsInput: string;
  setQuizMaxAttemptsInput: (v: string) => void;
  quizRetryAfterInput: string;
  setQuizRetryAfterInput: (v: string) => void;
  commitNumber: (key: NumericSettingKey, raw: string, reset: (v: string) => void, label: string) => void;
  /** The shell's per-field save status, by stored key (UX audit F2). Optional
   *  so a static render without a shell still works; idle when absent. */
  statusOf?: (key: string) => FieldStatus;
  /** The module screen's settings card slot (identity editor + Hints link);
   *  absent, the knobs render bare — see components/admin/settings-card.tsx. */
  moduleSettings?: ModuleSettingsSlot;
  /** Test/first-paint seed only — see header comment. */
  initialQuestions?: AdminQuestion[];
  /** Seeds the loaded flag — same test seam as the two above. */
  initialLoaded?: boolean;
  /** Reports the bank's size to the shell for the setup checklist above this
   *  panel, AFTER the mount-time fetch has settled and again on every change
   *  — never from the pre-hydration seed, which would report an empty bank
   *  for the second before the real list lands. */
  onInventory?: (inventory: ModuleInventory) => void;
};

export default function AdminQuizControls({
  pending,
  quizMaxAttemptsInput,
  setQuizMaxAttemptsInput,
  quizRetryAfterInput,
  setQuizRetryAfterInput,
  commitNumber,
  statusOf = () => ({ state: "idle" }),
  moduleSettings,
  initialQuestions = [],
  initialLoaded = false,
  onInventory,
}: AdminQuizControlsProps) {
  // The bank, the open editor, the delete target and every write over them
  // live in the shared resource hook (components/admin/use-admin-resource.ts).
  // What is quiz-shaped is the config: the endpoint, where a row keeps its
  // id/order, how the route's replies map to rows, and the payload builders
  // above. `initialQuestions` seeds the first paint; the hook's mount-time
  // GET replaces it in the browser (never under `renderToStaticMarkup`).
  const resource = useAdminResource<AdminQuestion, Question, QuestionEditor, QuestionPayload>({
    endpoint: "/api/admin/quiz",
    describeError: describeQuizError,
    rows: QUESTION_ROWS,
    parseList: (data) => ({ rows: Array.isArray(data.questions) ? (data.questions as AdminQuestion[]) : [], categories: [] }),
    loadErrorMessage: "Couldn't load questions — check your connection and try again.",
    // The route echoes the STORED (deduped, sorted) correct set alongside
    // the question; falling back to the payload's own set would leave the
    // list holding something the store never wrote.
    parseUpsert: (data, payload) => {
      const question = data.question as Question | undefined;
      if (!question) return null;
      return { question, correct: (data.correct as string[] | undefined) ?? payload.correct };
    },
    toPayload: payloadFromEditor,
    rowPayload: payloadFromRow,
    initialRows: initialQuestions,
    initialLoaded,
    initialCategories: [],
    // A summary of a write does not outlive the next write (#127).
    onWrite: () => bundleImport.retire(),
  });
  const { rows: questions, loaded, listError, editing, formPending, deleteTarget, reorderPending, nextOrder } = resource;

  // The bulk import/export flow (textarea, file pick, `{import}` POST,
  // after-import summary) — see components/admin/use-bundle-import.ts. On
  // success the bank is re-read from the server, never hand-patched.
  const bundleImport = useBundleImport<QuizImportSummary>({
    endpoint: "/api/admin/quiz",
    describeError: describeQuizError,
    parse: parseBundle,
    parseSummary: (reply) => ({ created: reply.created ?? 0, updated: reply.updated ?? 0 }),
    afterImport: resource.reload,
  });

  // Report the bank's size upward whenever it changes, once it is real. The
  // callback is the parent's, so this is a report to a subscriber, not a
  // setState of this component's own.
  useEffect(() => {
    if (loaded) onInventory?.(quizInventory(questions));
  }, [loaded, questions, onInventory]);

  const confirmCopy = deleteTarget ? questionDeleteConfirm(deleteTarget) : null;

  const knobs = (
    <>
      <AdminNumberField
        id="quiz-max-attempts"
        label="Max attempts"
        help="Attempts each contestant gets on a question before the retry gate refuses further submissions. 0 = unlimited. Counted per contestant, not per team: a team of N members gets N times this."
        value={quizMaxAttemptsInput}
        placeholder={String(QUIZ_MAX_ATTEMPTS)}
        disabled={pending}
        status={statusOf("quizMaxAttempts")}
        onChange={setQuizMaxAttemptsInput}
        onBlur={() => commitNumber("quizMaxAttempts", quizMaxAttemptsInput, setQuizMaxAttemptsInput, "Max attempts")}
      />

      <AdminNumberField
        id="quiz-retry-after-min"
        label="Retry after (min)"
        help="Minutes a contestant must wait after their last attempt before retrying the same question. 0 = no cooldown."
        value={quizRetryAfterInput}
        placeholder={String(QUIZ_RETRY_AFTER_MIN)}
        disabled={pending}
        status={statusOf("quizRetryAfterMin")}
        onChange={setQuizRetryAfterInput}
        onBlur={() => commitNumber("quizRetryAfterMin", quizRetryAfterInput, setQuizRetryAfterInput, "Retry after (min)")}
      />
    </>
  );

  return (
    <>
      {moduleSettings ? (
        <AdminSettingsCard identity={moduleSettings.identity} onHints={moduleSettings.onHints}>
          {knobs}
        </AdminSettingsCard>
      ) : (
        knobs
      )}

      <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-white">Questions</span>
          <button
            type="button"
            disabled={formPending}
            onClick={() => resource.openEditor(newQuestionEditor(nextOrder))}
            className="rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
          >
            Add question
          </button>
        </div>

        {listError && <p className="text-sm text-[#e53e3e]">{listError}</p>}

        {/* The collapsed list shows the public half only — which choice is
            correct appears when the organizer opens the edit form, not on a
            panel that might be on a projector. */}
        <SortableList<AdminQuestion>
          rows={questions}
          keyOf={(row) => row.question.id}
          titleOf={(row) => row.question.prompt}
          meta={(row) => (
            <>
              {row.question.type} · {row.question.points} pt
              {row.question.points === 1 ? "" : "s"} · {row.question.choices.length} choices
            </>
          )}
          intro="Drag a question to reorder it, or use Move up / Move down from its ⋯ menu. Contestants see them in this order."
          emptyText="No questions yet."
          loading={!resource.loaded}
          reorderPending={reorderPending}
          onMove={(from, to) => void resource.move(from, to)}
          onEdit={(row) => resource.openEditor(editorFromQuestion(row))}
          onDelete={(row) => resource.requestDelete(row.question)}
        />
      </div>

      <ImportPanel
        exportDescription="Downloads every question currently in the bank as one JSON file, correct answers included."
        exportLabel="Export questions"
        exportDisabled={questions.length === 0}
        onExport={() => downloadJson(serializeBundle(exportBundleFrom(questions)), "quiz-questions.json")}
        notice={
          <>
            Import never deletes existing questions — anything already in the bank that isn&rsquo;t in the file is
            left untouched. Max attempts and Retry after are not part of a bundle: importing one never changes
            the retry gate you set above.
          </>
        }
        text={bundleImport.text}
        pending={bundleImport.pending}
        clientErrors={bundleImport.clientErrors}
        importErrors={bundleImport.importErrors}
        summary={bundleImport.result ? formatImportSummary(bundleImport.result) : null}
        canImport={bundleImport.canImport}
        onText={bundleImport.setText}
        onFile={(e) => void bundleImport.handleFile(e)}
        onSubmit={() => void bundleImport.submit()}
      />

      {editing && (
        <QuestionForm
          editor={editing}
          pending={formPending}
          error={resource.formError}
          onChange={(draft) => resource.setEditing({ ...editing, draft })}
          onCancel={resource.cancelEditor}
          onSubmit={() => void resource.submitEditor(editing)}
        />
      )}

      {/* Audit F17: Edit on another row, or Add, parks the new editor
          here rather than replacing a half-written draft in silence. */}
      {resource.pendingEditor && (
        <DiscardDraftConfirm
          noun="question"
          onConfirm={resource.confirmDraftSwitch}
          onCancel={resource.cancelDraftSwitch}
        />
      )}

      {deleteTarget && confirmCopy && (
        <ConfirmDelete
          copy={confirmCopy}
          error={resource.deleteError}
          pending={resource.deletePending}
          onConfirm={() => void resource.remove(deleteTarget.id)}
          onCancel={resource.cancelDelete}
        />
      )}
    </>
  );
}
