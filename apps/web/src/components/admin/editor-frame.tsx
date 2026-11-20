"use client";

// The add/edit form's outer shell, shared by the module admin panels' forms
// (quiz's QuestionForm, classic's ChallengeForm): the
// bordered card, its heading, the id block that is shown and never editable,
// the error line a failed save lands on, and the Cancel/Submit footer. The
// three forms used to repeat every line of this; only the nouns differed.
//
// Two behaviours live here because all three forms needed them identically:
//
//   - The form opens BELOW the full item list, while the button that opens
//     it sits above — on a board of a dozen items the click appeared to do
//     nothing (issue #200, 3.4). So the card scrolls itself into view and
//     puts the cursor in its first text input on every open, keyed on WHICH
//     item is being edited (`focusKey`) rather than on mount alone: clicking
//     Edit on another row (same mounted form, new subject) counts as a fresh
//     open, while a keystroke re-render does not re-steal the scroll. A form
//     whose first field is not a plain text input marks the field it wants
//     with `EDITOR_FOCUS_ATTR` — see the constant.
//   - The id is never an input. On an existing item it is the reference every
//     banked answer or solve points at, so changing it would orphan them; on a
//     new one it does not exist yet (it is minted from the prompt or title at
//     save). `IdBlock` renders it as code, or states that it will be
//     generated — the exact sentences are the module's.

import { useEffect, useRef, type ReactNode } from "react";

/** Marks the control an editor wants focused on open, for a form whose first
 *  field is not a plain text input. The quiz's is a textarea (the prompt), so
 *  the `input[type='text']` fallback below skipped past it and landed on the
 *  first choice-id input — the cursor sat in storage plumbing rather than in
 *  the sentence the organizer came to write (#282). Put it on the control
 *  itself: `<textarea {...{ [EDITOR_FOCUS_ATTR]: "" }} />`. */
export const EDITOR_FOCUS_ATTR = "data-editor-focus";

/** The card's heading: the add label for a new item, `Edit "<phrase>"` for
 *  an existing one (the phrase being the same one the delete confirmation
 *  would ask for). Exported for direct testing. */
export function editorHeading(isNew: boolean, addLabel: string, phrase: string): string {
  return isNew ? addLabel : `Edit "${phrase}"`;
}

/** The item's id, shown and never editable — see the header comment. */
export function IdBlock({
  label,
  id,
  fixedHelp,
  generatedHelp,
}: {
  /** "Question id" / "Challenge id". */
  label: string;
  /** The stored id of an existing item; undefined for a new one. */
  id: string | undefined;
  /** Why the id cannot change — names what is recorded against it. */
  fixedHelp: ReactNode;
  /** What a new item's id is generated from. */
  generatedHelp: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{label}</span>
      {id !== undefined ? (
        <>
          <code className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-zinc-300">{id}</code>
          <span className="text-sm text-muted">{fixedHelp}</span>
        </>
      ) : (
        <span className="text-sm text-muted">{generatedHelp}</span>
      )}
    </div>
  );
}

export default function EditorFrame({
  heading,
  focusKey,
  pending,
  valid,
  isNew,
  addLabel,
  error,
  onCancel,
  onSubmit,
  children,
}: {
  heading: string;
  /** Identifies what is being edited (the item's id, or "new"); a change
   *  re-runs the scroll-into-view and focus. */
  focusKey: string;
  pending: boolean;
  /** Whether the draft could be submitted as-is; gates the submit button. */
  valid: boolean;
  isNew: boolean;
  /** The submit label for a new item ("Add question" / "Add challenge"); an
   *  existing one reads "Save changes". */
  addLabel: string;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = formRef.current;
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const target =
      card?.querySelector<HTMLElement>(`[${EDITOR_FOCUS_ATTR}]`) ??
      card?.querySelector<HTMLElement>("input[type='text']");
    target?.focus({ preventScroll: true });
  }, [focusKey]);

  return (
    <div ref={formRef} className="flex flex-col gap-3 rounded-md border border-[#2563eb]/30 bg-white/[0.04] p-4">
      <h4 className="text-sm font-semibold text-white">{heading}</h4>

      {children}

      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending || !valid}
          className="rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : isNew ? addLabel : "Save changes"}
        </button>
      </div>
    </div>
  );
}
