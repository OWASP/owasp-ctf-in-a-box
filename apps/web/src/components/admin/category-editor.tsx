"use client";

// The category manager the classic admin panel renders above its
// challenge list: the current list as a row of inline chips, in the order
// contestants see them, each with keyboard-operable move-left / move-right
// and a remove control, plus a New-category input with its Add button
// (admin-redesign.md § Content screens). It used to be one bordered row per
// category with three full-size buttons each — a twelve-category board was a
// screen of Move up / Move down / Remove before the first challenge.
//
// The per-chip controls are kept at low opacity until the chip is hovered
// or one of them has focus — never hidden outright, so a keyboard user
// tabbing through still sees where they are, and a touch user still has a
// target. Remove is a neutral control: danger colour is reserved for the
// confirmations that actually destroy something (redesign § Controls), and
// removing a category that is still in use is refused with a sentence, not
// performed.
//
// Presentational. State and writes live in `useCategoryEditor`; the panel
// wires the two together.

import { INPUT_CLASS } from "@/components/admin/editor-fields";

const CHIP_BUTTON =
  "rounded-full px-1.5 py-0.5 text-xs leading-none text-zinc-300 hover:bg-white/[0.08] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#d4a017] disabled:opacity-30 disabled:hover:bg-transparent";

export default function CategoryEditor({
  categories,
  input,
  error,
  pending,
  onInput,
  onAdd,
  onRemove,
  onMove,
  renaming = null,
  renameInput = "",
  onRenameInput,
  onStartRename,
  onCancelRename,
  onCommitRename,
  loading = false,
}: {
  categories: readonly string[];
  input: string;
  error: string | null;
  pending: boolean;
  onInput: (value: string) => void;
  onAdd: () => void;
  onRemove: (name: string) => void;
  onMove: (from: number, to: number) => void;
  /** The chip currently open for renaming, or null (#304). */
  renaming?: string | null;
  renameInput?: string;
  onRenameInput?: (value: string) => void;
  onStartRename?: (name: string) => void;
  onCancelRename?: () => void;
  onCommitRename?: () => void;
  /** True while the first read is still in flight — see the note below. */
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-white">Categories</span>
        <span className="text-sm text-muted">
          In the order contestants see them. Hover a chip for its controls; renaming one carries its challenges across.
        </span>
      </div>
      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}
      {categories.length === 0 ? (
        // "Checking…" while the first read is in flight: telling an organizer
        // their categories are gone before we have looked is the same defect
        // as the hint banner's (issue #331).
        <p className="text-sm text-muted">
          {loading ? "Checking…" : "No categories yet — add one before authoring a challenge."}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {categories.map((name, i) => (
            <li
              key={name}
              className="group flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-3 pr-1 text-sm text-white"
            >
              {renaming === name ? (
                // The chip becomes its own edit field: a rename is an edit of
                // the name in place, and moving it to a dialog would separate
                // it from the list it has to stay legible against.
                <>
                  <input
                    autoFocus
                    value={renameInput ?? ""}
                    disabled={pending}
                    aria-label={`Rename "${name}"`}
                    onChange={(e) => onRenameInput?.(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onCommitRename?.();
                      if (e.key === "Escape") onCancelRename?.();
                    }}
                    className="w-40 rounded-sm border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#d4a017]"
                  />
                  <span className="flex items-center gap-0.5">
                    <button type="button" disabled={pending} onClick={() => onCommitRename?.()} className={CHIP_BUTTON}>
                      Save
                    </button>
                    <button type="button" disabled={pending} onClick={() => onCancelRename?.()} className={CHIP_BUTTON}>
                      Cancel
                    </button>
                  </span>
                </>
              ) : (
                <>
              <span className="max-w-56 truncate">{name}</span>
              <span className="flex items-center gap-0.5 opacity-40 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  aria-label={`Move "${name}" left`}
                  disabled={pending || i === 0}
                  onClick={() => onMove(i, i - 1)}
                  className={CHIP_BUTTON}
                >
                  <span aria-hidden="true">◂</span>
                </button>
                <button
                  type="button"
                  aria-label={`Move "${name}" right`}
                  disabled={pending || i === categories.length - 1}
                  onClick={() => onMove(i, i + 1)}
                  className={CHIP_BUTTON}
                >
                  <span aria-hidden="true">▸</span>
                </button>
                {/* Held while ANOTHER chip is mid-rename: `startRename`
                    replaces the draft outright, so a second Rename click would
                    discard whatever was typed into the first with nothing
                    said. Only the competing Rename buttons are disabled — Move
                    and Remove are keyed by name and leave the open draft
                    alone, and the chip being renamed renders neither. */}
                <button
                  type="button"
                  aria-label={`Rename "${name}"`}
                  disabled={pending || renaming !== null}
                  onClick={() => onStartRename?.(name)}
                  className={CHIP_BUTTON}
                >
                  <span aria-hidden="true">✎</span>
                  <span className="sr-only">Rename</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove "${name}"`}
                  disabled={pending}
                  onClick={() => onRemove(name)}
                  className={CHIP_BUTTON}
                >
                  <span aria-hidden="true">×</span>
                  <span className="sr-only">Remove</span>
                </button>
              </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          value={input}
          placeholder="New category"
          disabled={pending}
          onChange={(e) => onInput(e.target.value)}
          className={`flex-1 ${INPUT_CLASS}`}
        />
        <button
          type="button"
          disabled={pending || input.trim().length === 0}
          onClick={onAdd}
          className="rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
        >
          Add category
        </button>
      </div>
    </div>
  );
}
