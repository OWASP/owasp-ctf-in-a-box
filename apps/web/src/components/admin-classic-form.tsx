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

import type { ReactNode } from "react";
import { CLASSIC_POINTS_MAX } from "@/lib/classic-keys";
import {
  CLASSIC_ALT_FLAGS_MAX,
  CLASSIC_FLAG_PATTERNS_MAX,
  CLASSIC_FLAG_PATTERN_MAX_LEN,
  CLASSIC_PATTERN_INPUT_MAX,
  splitFlagLines,
} from "@/lib/classic-flags";
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
  MONO_INPUT_CLASS,
} from "@/components/admin/editor-fields";
import {
  type ChallengeDraft,
  type ChallengeEditor,
  confirmPhraseFromTitle,
  draftFlagListErrors,
  isDraftValid,
} from "@/components/admin-classic-model";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A one-entry-per-line secret list (#192). Masked like the flag: until the
 *  flag is revealed it shows only HOW MANY entries there are, so a
 *  screen-shared panel never shows them; revealed, a monospaced textarea. */
function SecretLinesField({
  label,
  help,
  value,
  revealed,
  hiddenNoun,
  disabled,
  error,
  onChange,
}: {
  label: string;
  help: ReactNode;
  value: string;
  revealed: boolean;
  hiddenNoun: [string, string];
  disabled: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const count = splitFlagLines(value).length;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted">
        <span className="text-white">{label}</span>
        <span className="block">{help}</span>
      </span>
      {revealed ? (
        <textarea
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          spellCheck={false}
          className={MONO_INPUT_CLASS}
        />
      ) : (
        <span className="text-sm text-muted">
          {count === 0
            ? "None. Reveal the flag above to add some."
            : `${plural(count, hiddenNoun[0], hiddenNoun[1])} hidden. Reveal the flag above to see or edit them.`}
        </span>
      )}
      {error && (
        <span role="alert" className="text-sm text-[#f87171]">
          {error}
        </span>
      )}
    </label>
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
  const listErrors = draftFlagListErrors(draft);

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

      <SecretLinesField
        label="Other accepted flags (optional)"
        help={
          <>
            One per line. Any of them solves the challenge exactly like the flag above: one solve, full
            points, counted once. Compared the same way — trimmed, and ignoring case unless the box below is
            ticked. At most {CLASSIC_ALT_FLAGS_MAX}.
          </>
        }
        value={draft.alternateFlags}
        revealed={flagRevealed}
        hiddenNoun={["other accepted flag", "other accepted flags"]}
        disabled={pending}
        error={listErrors.alternateFlags}
        onChange={(alternateFlags) => set({ alternateFlags })}
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

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.regexEnabled}
          disabled={pending}
          onChange={(e) => set({ regexEnabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 flex-none accent-[#2563eb]"
        />
        <span className="text-sm text-muted">
          <span className="text-white">Also accept flags matching a pattern (regex)</span>
          <span className="block">
            Off by default. For answers you cannot list — &ldquo;any 32 hex characters&rdquo;. Turning it off
            removes the patterns when you save.
          </span>
        </span>
      </label>

      {draft.regexEnabled && (
        <SecretLinesField
          label="Flag patterns"
          help={
            <>
              One JavaScript regular expression per line. Each must match the whole flag — it is anchored for
              you, so no ^ or $ — after the submission is trimmed. Case follows the case-sensitive box above:
              while it is off, [A-F] also matches a–f. Submissions over {CLASSIC_PATTERN_INPUT_MAX} characters
              are only compared against the flags, never a pattern. To keep matching fast, at most{" "}
              {CLASSIC_FLAG_PATTERNS_MAX} patterns of {CLASSIC_FLAG_PATTERN_MAX_LEN} characters, and no
              backreferences, lookarounds, or repeated group holding a repeat or | (like (a+)+); bound long
              repeats ({"{1,32}"} rather than +). A pattern that matches an empty flag or any input is refused.
            </>
          }
          value={draft.flagPatterns}
          revealed={flagRevealed}
          hiddenNoun={["pattern", "patterns"]}
          disabled={pending}
          error={listErrors.flagPatterns}
          onChange={(flagPatterns) => set({ flagPatterns })}
        />
      )}

      <HintField value={draft.hint} disabled={pending} onChange={(hint) => set({ hint })} />

      <DescriptionField value={draft.description} disabled={pending} onChange={(description) => set({ description })} />

      {/* #186: immediate writes of their own, never part of this draft's Save. */}
      <AdminAttachments key={editor.mode === "edit" ? editor.id : "new"} itemId={editor.mode === "edit" ? editor.id : null} />
    </EditorFrame>
  );
}
