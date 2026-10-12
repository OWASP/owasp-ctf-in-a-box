"use client";

// The form fields the module admin panels' add/edit forms share. The classic
// and ai challenge forms are the same form with two extra ai fields (solve
// mode, launch URL) and one classic-only readout (position, since only classic
// reorders by drag); the quiz form shares the points and position pair. Each
// field here is one `<label>` with the input the three forms rendered by hand,
// same markup, same classes, same help copy where the copy was the same — the
// one sentence that differed (case-sensitivity's explanation) is a prop.
//
// Presentational: every field takes its value and a change callback. The
// form owns the draft and decides what a change means.

import type { ReactNode } from "react";
import { MARKDOWN_MAX } from "@/lib/markdown";
import { instantToWall, wallToInstant, zoneLabel } from "@/lib/event-time";
import Markdown from "@/components/markdown";

/** The text control style every admin form field uses. */
export const INPUT_CLASS =
  "rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

/** The same, monospaced — flags, launch URLs, Markdown source. */
export const MONO_INPUT_CLASS =
  "rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-sm text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

type ValueField = {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

/** A plain single-line text input — the title.
 *
 *  `type="text"` is stated rather than left to the default. It renders
 *  identically either way, but `EditorFrame` finds the field to focus on open
 *  with an `input[type='text']` selector, and an attribute-less input does not
 *  match it — so the classic and ai forms opened with the cursor nowhere
 *  (#282). */
export function TextField({ label, value, disabled, onChange }: ValueField & { label: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted">{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    </label>
  );
}

/** A whole-number input in a `flex gap-3` row — points, or ai's position.
 *  `max` is rendered only when given (the quiz caps points nowhere). */
export function NumberField({ label, value, max, disabled, onChange }: ValueField & { label: string; max?: number }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-sm text-muted">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    </label>
  );
}

/** The category picker, in a row. A draft whose category is not in the
 *  current list (blank on a fresh draft, or removed since the draft opened)
 *  shows it as a disabled placeholder so the select is never silently
 *  re-pointed at the first real option. */
export function CategorySelect({
  value,
  categories,
  disabled,
  onChange,
}: ValueField & { categories: readonly string[] }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-sm text-muted">Category</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
        {!categories.includes(value) && (
          <option value={value} disabled>
            {value || "Select a category"}
          </option>
        )}
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Where the item sits, stated rather than typed: position is set by
 *  dragging (or Move up / Move down) in the list above. */
export function PositionReadout({ order, isNew }: { order: number; isNew: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <span className="text-sm text-muted">Position</span>
      <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-zinc-300">
        {isNew ? `#${order} (last)` : `#${order}`}
      </span>
    </div>
  );
}

/** The flag, masked. `type="password"` so a flag is never projected in the
 *  clear on a screen-shared admin panel; the Reveal toggle is the ONLY way to
 *  see it, and the form resets it on every fresh open. */
export function FlagField({
  value,
  revealed,
  onToggle,
  disabled,
  onChange,
}: ValueField & { revealed: boolean; onToggle: () => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted">
        Flag
        <button type="button" onClick={onToggle} className="ml-2 text-white hover:underline">
          {revealed ? "Hide" : "Reveal"}
        </button>
      </span>
      <input
        type={revealed ? "text" : "password"}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={MONO_INPUT_CLASS}
      />
    </label>
  );
}

/** Whether the flag compares with capitalisation intact (issue #193).
 *  Rendered directly under the flag because it changes what that flag MEANS.
 *  The explanation is the module's: classic tells the organizer contestants
 *  are warned on the card; ai has no card to warn on. */
export function CaseSensitiveField({
  checked,
  disabled,
  onChange,
  help,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  help: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-none accent-[#2563eb]"
      />
      <span className="text-sm text-muted">
        <span className="text-white">Case-sensitive flag</span>
        <span className="block">{help}</span>
      </span>
    </label>
  );
}

/** "Visible to contestants": off keeps the challenge out of every contestant
 *  payload (board, page, leaderboard, grading) until it is switched back on.
 *  Solves already banked on it stay. */
export function VisibleField({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby="visible-help"
        className="mt-0.5 h-4 w-4 flex-none accent-[#2563eb]"
      />
      <span className="text-sm text-muted">
        <span className="text-white">Visible to contestants</span>
        <span id="visible-help" className="block">
          Off hides it everywhere a contestant looks: the board, its page, the leaderboard and grading answer as if
          it did not exist. Points already banked on it stay.
        </span>
      </span>
    </label>
  );
}

/** "Release at": the instant a hidden challenge goes live on its own. The
 *  datetime-local value is a wall time read on the EVENT's clock (`zone`),
 *  never the organizer's laptop; `value` and `onChange` carry the UTC ISO
 *  instant it stands for, "" for none. The form only opens on a click, so
 *  the server never renders a value the browser would disagree with. */
export function ReleaseAtField({
  value,
  zone,
  disabled,
  onChange,
}: ValueField & { zone: string }) {
  const ms = value ? Date.parse(value) : NaN;
  const offset = zoneLabel(zone, Number.isFinite(ms) ? ms : Date.parse("2000-01-01T00:00:00Z"));
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted">
        Release at (optional, {zone === "UTC" ? "UTC" : `${zone}, ${offset}`}). Leave empty to switch it on by hand.
      </span>
      <input
        type="datetime-local"
        value={instantToWall(value || null, zone)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? (wallToInstant(e.target.value, zone) ?? "") : "")}
        className={INPUT_CLASS}
      />
      <span className="text-xs text-muted">
        {value
          ? `Hidden until then, then live on its own with nothing to run. Stored as ${value}.`
          : "No release time: the switch above decides."}
      </span>
    </label>
  );
}

/** The optional paid hint (#190). Empty = no hint; saving an emptied field is
 *  a deliberate clear. */
export function HintField({ value, disabled, onChange }: ValueField) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted">
        Hint (optional). Contestants pay the configured hint cost to reveal it — leave empty for no
        hint. Secret until purchased, like the flag.
      </span>
      <textarea value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} rows={2} className={INPUT_CLASS} />
    </label>
  );
}

/** The Markdown description with a live preview through the SAME renderer
 *  the contestant board uses — a second renderer here would drift and this
 *  would stop being a preview of anything real. */
export function DescriptionField({ value, disabled, onChange }: ValueField) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Description (Markdown, max {MARKDOWN_MAX} characters)</span>
        <textarea
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          maxLength={MARKDOWN_MAX}
          className={MONO_INPUT_CLASS}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">Preview</span>
        <div className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
          <Markdown source={value} />
        </div>
      </div>
    </>
  );
}
