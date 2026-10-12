"use client";

// The frame the two challenge-authoring module admin panels (classic and ai)
// share: the settings-card slot around the module's own knob, the category
// editor wiring, the "Challenges" panel shell — heading, Add button,
// list-error line, grouped SortableList — and the three dialogs below it: the
// add/edit form, the draft-discard confirmation and the typed-title delete
// confirmation. admin-classic-controls.tsx and admin-ai-controls.tsx each
// carried every line of this, down to the sentences and class names; only the
// module's own model, form and blocks around the list differed. Extracted the
// way admin/fetch.ts, admin/sortable-list.tsx and admin/use-admin-resource.ts
// were — one implementation, so a change to the shared frame lands once
// (issue #504, finding M14).
//
// What stays the module's, and why:
//
//   - The resource and category-editor configs (endpoint, error mapper,
//     payload builders) — that IS the module's wire contract, so the panel
//     still owns both hooks and passes their state in here.
//   - `newEditor` / `editorFromRow` / `deleteConfirm` — the pure model
//     builders (admin-classic-model.ts / admin-ai-model.ts) each module
//     already exports.
//   - `meta` — what the collapsed row's second line says is the panel's
//     choice (classic: points; ai: points plus mode), the same rule as
//     SortableList's own `meta`. The id/title/category accessors are NOT
//     parameters: every row here is `{ challenge: {...} }`, so the frame
//     reads those itself.
//   - `onRetry` — ai's list-error line offers a Retry button, classic's has
//     never had one; the button renders only when the module asks for it, so
//     the two keep the markup they have today.
//   - The four slots: `beforePanel` (classic's story editor), `panelIntro`
//     (ai's board-level endpoints block and external-site setup),
//     `panelNotice` (ai's rotate error), `afterPanel` (classic's bulk
//     import/export). Their order around the panel is the order each panel
//     already rendered them in.
//   - `intro` / `reorderPending` / `onMove` / `rowExtra` — SortableList's
//     module knobs: classic reorders, ai renders an integration disclosure
//     under each row.
//
// The flag-reveal state lives HERE rather than in each panel because all
// three things that touch it are in this frame: the Add button, every row's
// Edit, and the open form. Opening an editor always starts masked — the same
// projector-safety rule both panels apply to the list itself.

import { useState, type ComponentType, type ReactNode } from "react";
import CategoryEditor from "@/components/admin/category-editor";
import type { CategoryEditorState } from "@/components/admin/use-category-editor";
import ConfirmDelete, { type DeleteConfirmCopy } from "@/components/admin/confirm-delete";
import DiscardDraftConfirm from "@/components/admin/discard-draft-confirm";
import AdminSettingsCard, { type ModuleSettingsSlot } from "@/components/admin/settings-card";
import SortableList from "@/components/admin/sortable-list";
import type { AdminResource } from "@/components/admin/use-admin-resource";

/** The row shape this frame reads on its own (id/title/category). Every
 *  module row is `{ challenge: {...} }` — see the `*_ROWS` accessors in the
 *  model files. */
export type ChallengeRowShape = { challenge: { id: string; title: string; category: string } };

/** What an editor looks like to the frame: a discriminated union, so the id
 *  is reachable only in the edit case — mirrors `ChallengeEditor` and
 *  `AiChallengeEditor`, which is what a panel passes. `draft` is `unknown`
 *  here and pinned to the module's own draft type through the form slot. */
export type EditorSlot = { mode: "new"; draft: unknown } | { mode: "edit"; id: string; draft: unknown };

/** The add/edit form slot — what `ChallengeForm` and `AiChallengeForm`
 *  already take, field for field. `onChange` carries the module's DRAFT (the
 *  form cannot touch the id or position — see each form's own comment). */
export type ChallengeFormSlot<Editor extends EditorSlot> = {
  editor: Editor;
  categories: readonly string[];
  pending: boolean;
  error: string | null;
  flagRevealed: boolean;
  setFlagRevealed: (v: boolean) => void;
  onChange: (draft: Editor["draft"]) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export type ChallengeFrameProps<Row extends ChallengeRowShape, Editor extends EditorSlot> = {
  /** The module screen's settings card slot (identity editor + Hints link);
   *  absent, `knob` renders bare — see components/admin/settings-card.tsx. */
  moduleSettings?: ModuleSettingsSlot;
  /** The module's own knob(s), already built by the panel. */
  knob: ReactNode;
  /** The panel's list-plus-editor state (components/admin/
   *  use-admin-resource.ts) — the frame renders from it and never writes
   *  beyond opening/closing the editors and dialogs below. */
  resource: AdminResource<Row, Row["challenge"], Editor>;
  /** The category editor's own state (components/admin/
   *  use-category-editor.ts); the list it edits rides on `resource`. */
  categoryEditor: CategoryEditorState;
  /** `newChallengeEditor` / `newAiChallengeEditor` — what Add opens. */
  newEditor: (nextOrder: number, defaultCategory: string) => Editor;
  /** `editorFromChallenge` / `editorFromAiChallenge` — what Edit opens. */
  editorFromRow: (row: Row) => Editor;
  /** `challengeDeleteConfirm` / `aiChallengeDeleteConfirm` — the copy for the
   *  typed-title delete confirmation. */
  deleteConfirm: (item: Row["challenge"]) => DeleteConfirmCopy;
  /** The collapsed row's second line — the module's choice, see header. */
  meta: (row: Row) => ReactNode;
  /** `ChallengeForm` / `AiChallengeForm` — mounted while an editor is open. */
  Form: ComponentType<ChallengeFormSlot<Editor>>;
  /** Renders a Retry button beside the list error (ai); absent, the plain
   *  one-line error classic has always had. */
  onRetry?: () => void;
  /** Between the category editor and the panel (classic's story editor). */
  beforePanel?: ReactNode;
  /** Inside the panel, above the list-error line (ai's endpoints block and
   *  external-site setup). */
  panelIntro?: ReactNode;
  /** Inside the panel, below the list-error line (ai's rotate error). */
  panelNotice?: ReactNode;
  /** Below the panel (classic's bulk import/export). */
  afterPanel?: ReactNode;
  /** SortableList's own knobs: classic passes the reorder trio, ai the
   *  per-row integration disclosure. */
  intro?: string;
  reorderPending?: boolean;
  onMove?: (from: number, to: number) => void;
  rowExtra?: (row: Row) => ReactNode;
};

export default function ChallengeFrame<Row extends ChallengeRowShape, Editor extends EditorSlot>({
  moduleSettings,
  knob,
  resource,
  categoryEditor,
  newEditor,
  editorFromRow,
  deleteConfirm,
  meta,
  Form,
  onRetry,
  beforePanel,
  panelIntro,
  panelNotice,
  afterPanel,
  intro,
  reorderPending,
  onMove,
  rowExtra,
}: ChallengeFrameProps<Row, Editor>) {
  const { rows, categories, loaded, listError, editing, formPending, formError, deleteTarget, deletePending, deleteError, pendingEditor } =
    resource;
  // Always masked on open: Add and Edit both reset it before the form mounts
  // (see the handlers below), and only the form's own reveal toggle ever
  // flips it back.
  const [flagRevealed, setFlagRevealed] = useState(false);
  const confirmCopy = deleteTarget ? deleteConfirm(deleteTarget) : null;

  return (
    <>
      {moduleSettings ? (
        <AdminSettingsCard identity={moduleSettings.identity} onHints={moduleSettings.onHints}>
          {knob}
        </AdminSettingsCard>
      ) : (
        knob
      )}

      <CategoryEditor
        loading={!loaded}
        categories={categories}
        input={categoryEditor.input}
        error={categoryEditor.error}
        pending={categoryEditor.pending}
        onInput={categoryEditor.setInput}
        onAdd={categoryEditor.add}
        onRemove={categoryEditor.remove}
        onMove={categoryEditor.move}
        renaming={categoryEditor.renaming}
        renameInput={categoryEditor.renameInput}
        onRenameInput={categoryEditor.setRenameInput}
        onStartRename={categoryEditor.startRename}
        onCancelRename={categoryEditor.cancelRename}
        onCommitRename={categoryEditor.commitRename}
      />

      {beforePanel}

      <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-white">Challenges</span>
          <button
            type="button"
            disabled={formPending || categories.length === 0}
            onClick={() => {
              setFlagRevealed(false);
              resource.openEditor(newEditor(resource.nextOrder, categories[0] ?? ""));
            }}
            className="rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
          >
            Add challenge
          </button>
        </div>

        {panelIntro}

        {listError && (
          <p className="text-sm text-[#e53e3e]">
            {listError}
            {onRetry && (
              <>
                {" "}
                <button type="button" onClick={onRetry} className="text-white hover:underline">
                  Retry
                </button>
              </>
            )}
          </p>
        )}

        {panelNotice}

        {/* The collapsed list shows the public half only — the flag appears
            when the organizer opens the edit form, not on a panel that might
            be on a projector. */}
        <SortableList<Row>
          rows={rows}
          keyOf={(row) => row.challenge.id}
          titleOf={(row) => row.challenge.title}
          // Grouped by category, as contestants see the board; the category
          // is the heading, so the meta line does not repeat it.
          groupOf={(row) => row.challenge.category}
          groups={categories}
          meta={meta}
          intro={intro}
          emptyText="No challenges yet."
          loading={!loaded}
          reorderPending={reorderPending}
          onMove={onMove}
          onEdit={(row) => {
            setFlagRevealed(false);
            resource.openEditor(editorFromRow(row));
          }}
          onDelete={(row) => resource.requestDelete(row.challenge)}
          rowExtra={rowExtra}
        />
      </div>

      {afterPanel}

      {editing && (
        <Form
          key={editing.mode === "edit" ? editing.id : "new"}
          editor={editing}
          categories={categories}
          pending={formPending}
          error={formError}
          flagRevealed={flagRevealed}
          setFlagRevealed={setFlagRevealed}
          onChange={(draft) => resource.setEditing({ ...editing, draft })}
          onCancel={resource.cancelEditor}
          onSubmit={() => void resource.submitEditor(editing)}
        />
      )}

      {/* Audit F17: Edit on another row, or Add, parks the new editor
          here rather than replacing a half-written draft in silence. */}
      {pendingEditor && (
        <DiscardDraftConfirm
          noun="challenge"
          onConfirm={resource.confirmDraftSwitch}
          onCancel={resource.cancelDraftSwitch}
        />
      )}

      {deleteTarget && confirmCopy && (
        <ConfirmDelete
          copy={confirmCopy}
          error={deleteError}
          pending={deletePending}
          onConfirm={() => void resource.remove(deleteTarget.id)}
          onCancel={resource.cancelDelete}
        />
      )}
    </>
  );
}
