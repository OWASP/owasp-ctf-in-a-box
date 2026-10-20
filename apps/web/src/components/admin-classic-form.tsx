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

import { CLASSIC_HINT_MAX, CLASSIC_POINTS_MAX } from "@/lib/classic-keys";
import { HINT_COST_MAX } from "@/lib/hint-defaults";
import { HINT_LEVELS_MAX } from "@/lib/hint-ladder";
import AdminAttachments from "@/components/admin-attachments";
import EditorFrame, { IdBlock, editorHeading } from "@/components/admin/editor-frame";
import {
  CaseSensitiveField,
  CategorySelect,
  DescriptionField,
  FlagField,
  INPUT_CLASS,
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

/** The ordered ladder editor (#594). One row per rung, in purchase order;
 *  blank price means the event-wide hintCost. Reordering is explicit
 *  up/down buttons rather than drag so keyboard users get the same control. */
function HintLadderField({
  hints,
  disabled,
  onChange,
}: {
  hints: ChallengeDraft["hints"];
  disabled: boolean;
  onChange: (hints: ChallengeDraft["hints"]) => void;
}) {
  const replace = (index: number, patch: Partial<ChallengeDraft["hints"][number]>) =>
    onChange(hints.map((hint, i) => (i === index ? { ...hint, ...patch } : hint)));
  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= hints.length) return;
    const next = [...hints];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-muted">
        Hints (optional). Contestants buy these in order — hint 2 unlocks only after hint 1 is bought.
        Leave a price empty to use the event-wide hint cost. Secret until purchased, like the flag.
      </span>
      {hints.length === 0 && <p className="text-xs text-muted">No hints for this challenge.</p>}
      {hints.map((hint, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border border-white/10 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wide text-muted">Hint {i + 1}</span>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
                className="rounded border border-white/10 px-2 py-0.5 text-xs text-muted hover:text-white disabled:opacity-40"
              >
                Move up
              </button>
              <button
                type="button"
                disabled={disabled || i === hints.length - 1}
                onClick={() => move(i, 1)}
                className="rounded border border-white/10 px-2 py-0.5 text-xs text-muted hover:text-white disabled:opacity-40"
              >
                Move down
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(hints.filter((_, j) => j !== i))}
                className="rounded border border-white/10 px-2 py-0.5 text-xs text-muted hover:text-[#e53e3e] disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
          <textarea
            value={hint.text}
            disabled={disabled}
            maxLength={CLASSIC_HINT_MAX}
            rows={2}
            aria-label={`Hint ${i + 1} text`}
            onChange={(e) => replace(i, { text: e.target.value })}
            className={INPUT_CLASS}
          />
          <label className="flex items-center gap-2 text-xs text-muted">
            Price
            <input
              type="number"
              min={0}
              max={HINT_COST_MAX}
              value={hint.cost}
              disabled={disabled}
              placeholder="Event default"
              aria-label={`Hint ${i + 1} price (blank uses the event default)`}
              onChange={(e) => replace(i, { cost: e.target.value })}
              className={`${INPUT_CLASS} w-32`}
            />
            <span>blank = event default</span>
          </label>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || hints.length >= HINT_LEVELS_MAX}
        onClick={() => onChange([...hints, { text: "", cost: "" }])}
        className="w-fit rounded-md border border-white/10 px-3 py-1.5 text-sm text-muted hover:text-white disabled:opacity-40"
      >
        Add hint
      </button>
    </div>
  );
}

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

      <HintLadderField hints={draft.hints} disabled={pending} onChange={(hints) => set({ hints })} />

      <DescriptionField value={draft.description} disabled={pending} onChange={(description) => set({ description })} />

      {/* #186: immediate writes of their own, never part of this draft's Save. */}
      <AdminAttachments key={editor.mode === "edit" ? editor.id : "new"} itemId={editor.mode === "edit" ? editor.id : null} />
    </EditorFrame>
  );
}
