"use client";

// Re-exported from admin-classic-controls.tsx so the masking/preview/
// no-id properties can be proven directly against the SAME component this
// module renders — not a copy — without first driving the parent's `editing`
// useState open. That gating is real (see the header comment on why this
// repo's tests use `renderToStaticMarkup`, which never runs an effect or a
// click handler), so a static render of `<AdminClassicControls>` alone can
// prove the list and its buttons but not the form's own markup.
//
// Built on the shared EditorFrame/IdBlock and fields (components/admin);
// takes a DRAFT (`ChallengeDraft`) and can therefore never express a change
// to a challenge's id or position.

import { CLASSIC_POINTS_MAX } from "@/lib/classic-keys";
import AdminAttachments from "@/components/admin-attachments";
import EditorFrame, { IdBlock, editorHeading } from "@/components/admin/editor-frame";
import {
  CaseSensitiveField,
  CategorySelect,
  DescriptionField,
  FlagField,
  HintField,
  NumberField,
  PositionReadout,
  TextField,
} from "@/components/admin/editor-fields";
import {
  type ChallengeDraft,
  type ChallengeEditor,
  confirmPhraseFromTitle,
  isDraftValid,
} from "@/components/admin-classic-model";

export function ChallengeForm({
  editor,
  categories,
  pending,
  error,
  flagRevealed,
  setFlagRevealed,
  onChange,
  onCancel,
  onSubmit,
}: {
  editor: ChallengeEditor;
  categories: readonly string[];
  pending: boolean;
  error: string | null;
  flagRevealed: boolean;
  setFlagRevealed: (v: boolean) => void;
  // Takes a DRAFT, not an editor: this form cannot express a change to the
  // challenge's id or its position, which is what keeps an existing
  // challenge's id immutable no matter how this component is edited later.
  onChange: (draft: ChallengeDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const draft = editor.draft;
  const isNew = editor.mode === "new";
  const set = (patch: Partial<ChallengeDraft>) => onChange({ ...draft, ...patch });
  const phrase = editor.mode === "edit" ? confirmPhraseFromTitle(draft.title, editor.id) : "";

  return (
    <EditorFrame
      heading={editorHeading(isNew, "Add challenge", phrase)}
      focusKey={editor.mode === "edit" ? editor.id : "new"}
      pending={pending}
      valid={isDraftValid(draft, categories)}
      isNew={isNew}
      addLabel="Add challenge"
      error={error}
      onCancel={onCancel}
      onSubmit={onSubmit}
    >
      <IdBlock
        label="Challenge id"
        id={editor.mode === "edit" ? editor.id : undefined}
        fixedHelp="Fixed for the life of the challenge — contestants’ solves are recorded against it."
        generatedHelp="Generated from the title when you save."
      />

      <TextField label="Title" value={draft.title} disabled={pending} onChange={(title) => set({ title })} />

      <div className="flex gap-3">
        <CategorySelect value={draft.category} categories={categories} disabled={pending} onChange={(category) => set({ category })} />
        <NumberField label="Points" value={draft.points} max={CLASSIC_POINTS_MAX} disabled={pending} onChange={(points) => set({ points })} />
        {/* Position is set by dragging (or Move up / Move down) in the list
            above, so the form states where this challenge sits. */}
        <PositionReadout order={editor.order} isNew={isNew} />
      </div>

      <FlagField
        value={draft.flag}
        revealed={flagRevealed}
        onToggle={() => setFlagRevealed(!flagRevealed)}
        disabled={pending}
        onChange={(flag) => set({ flag })}
      />

      <CaseSensitiveField
        checked={draft.caseSensitive}
        disabled={pending}
        onChange={(caseSensitive) => set({ caseSensitive })}
        help={
          <>
            Off by default, which forgives the commonest contestant mistake. Turn it on only when the
            capitalisation IS the answer — a recovered password, a base64 string. Contestants are told
            on the challenge card, so nobody loses to a shift key without knowing why. Leading and
            trailing spaces are still forgiven either way.
          </>
        }
      />

      <HintField value={draft.hint} disabled={pending} onChange={(hint) => set({ hint })} />

      <DescriptionField value={draft.description} disabled={pending} onChange={(description) => set({ description })} />

      {/* #186: immediate writes of their own, never part of this draft's Save. */}
      <AdminAttachments key={editor.mode === "edit" ? editor.id : "new"} itemId={editor.mode === "edit" ? editor.id : null} />
    </EditorFrame>
  );
}
