"use client";

// The one numeric settings knob, used by every tab that has one (Event's
// players-per-team and hint knobs, Secure Development's re-run cooldown, the
// quiz retry gate, classic's and ai's cooldowns). Before this each tab wrote
// the same <label>/<input> pair by hand and none of them said whether the
// value saved: a blur-commit went out, a junk value snapped back with no
// message, and a server rejection landed as a developer-keyed string under
// the whole panel while the rejected text stayed in the field (UX audit F2).
//
// Presentational. The shell owns the draft string, the commit, and the
// per-field `status` it derives from that commit; this component renders the
// three states an organizer needs to see beside the field — "Saving…",
// "Saved", or the reason it was refused — and wires the refusal to the input
// for assistive tech (`role="alert"`, `aria-invalid`, `aria-describedby`).

import type { ReactNode } from "react";

/** What the shell knows about the last write to one field. `idle` is the
 *  resting state and what a fresh page starts in; `saved` is transient (the
 *  shell clears it after a moment); `rejected` carries the reason, already
 *  translated through the field's label. */
export type FieldStatus =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "saved" }
  | { state: "rejected"; message: string };

/** The shell's decision on blur, as data. `noop` when nothing changed;
 *  `post` with the parsed whole number, or null when a stored value is blanked
 *  (the server clears it and the default applies again); `snapback` with the
 *  sentence the field shows while the draft is reset to `current`. Exported
 *  for direct testing. */
export function parseNumberCommit(
  raw: string,
  current: number | null,
): { kind: "noop" } | { kind: "post"; value: number | null } | { kind: "snapback"; message: string } {
  const kept = current === null ? "the default" : String(current);
  // Blank over a stored value clears the override: the server removes it and
  // the default (the field's placeholder) applies again.
  if (raw.trim() === "") {
    return current === null ? { kind: "noop" } : { kind: "post", value: null };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { kind: "snapback", message: `Whole numbers only — kept ${kept}.` };
  }
  if (value === current) return { kind: "noop" };
  return { kind: "post", value };
}

/** Rewrites a server validation message (`lib/admin-store.ts` keys them by the
 *  stored field: `hintCost must be an integer in [0, 100000]`) into the
 *  sentence an organizer who read the LABEL can act on. Unrecognised messages
 *  are kept, prefixed by the label, never swallowed. Exported for direct
 *  testing. */
export function describeFieldError(label: string, serverMessage: string): string {
  const range = /^\S+ must be an integer in \[(\d+), (\d+)\]$/.exec(serverMessage);
  if (range) {
    const fmt = (n: string) => Number(n).toLocaleString("en-US");
    return `${label} must be a whole number between ${fmt(range[1])} and ${fmt(range[2])}.`;
  }
  const length = /^\S+ must be at most (\d+) characters$/.exec(serverMessage);
  if (length) return `${label} must be at most ${length[1]} characters.`;
  return `${label} could not be saved: ${serverMessage}`;
}

// No native spinner (admin-redesign.md § Controls): at this width the
// WebKit stepper sat over the last digit of a five-figure value, and a
// stepper that changes a stored setting by one on a stray scroll is the
// wrong control for numbers that are typed once. `type="number"` stays for
// the numeric keyboard and the min/max semantics. The CSS removes only the
// visible buttons — see `blurOnWheel` for the scroll half.
const INPUT_CLASS =
  "w-28 flex-none rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-right text-sm text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] aria-[invalid=true]:border-[#e53e3e]/70";

/** A focused `type="number"` input still steps its value on a mouse wheel
 *  with the buttons hidden, and the blur that follows would then SAVE the
 *  value the organizer never typed. Dropping focus inside the wheel handler
 *  is the one thing that stops the step (React registers wheel as passive,
 *  so `preventDefault` is not available); the blur commits whatever was
 *  actually typed, exactly as tabbing away does. Exported for direct
 *  testing — there is no browser harness in this repo, by choice. */
export function blurOnWheel(e: { currentTarget: { blur: () => void } }): void {
  e.currentTarget.blur();
}

/** The status line's colour per state. Rejected uses the panel's existing
 *  error red; saved the schedule readout's green. */
const STATUS_CLASS: Record<Exclude<FieldStatus["state"], "idle">, string> = {
  pending: "text-muted",
  saved: "text-[#22c55e]",
  rejected: "text-[#e53e3e]",
};

/** The three visible states, as one line under a field — "Saving…", "Saved",
 *  or the refusal — and nothing at all while idle. Shared with AdminSwitch
 *  (components/admin-switch.tsx) so a boolean row and a numeric knob report a
 *  save in exactly the same words, colour and place. A refusal is announced
 *  (`role="alert"`); the owning input points at `id` via `aria-describedby`. */
export function FieldStatusLine({ id, status }: { id: string; status: FieldStatus }) {
  const line =
    status.state === "pending" ? "Saving…" : status.state === "saved" ? "Saved" : status.state === "rejected" ? status.message : null;
  if (!line) return null;
  return (
    <p id={id} role={status.state === "rejected" ? "alert" : undefined} className={`text-right text-sm ${STATUS_CLASS[status.state as Exclude<FieldStatus["state"], "idle">]}`}>
      {line}
    </p>
  );
}

export default function AdminNumberField({
  id,
  label,
  help,
  value,
  placeholder,
  min = 0,
  max,
  disabled,
  status,
  onChange,
  onBlur,
}: {
  /** Stable id; the status line is `${id}-status` and the input points at it. */
  id: string;
  label: string;
  help?: ReactNode;
  value: string;
  placeholder: string;
  min?: number;
  max?: number;
  disabled: boolean;
  status: FieldStatus;
  onChange: (raw: string) => void;
  onBlur: () => void;
}) {
  const statusId = `${id}-status`;
  const rejected = status.state === "rejected";
  const hasLine = status.state !== "idle";
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="text-white">{label}</span>
          {help && <span className="block text-sm text-muted">{help}</span>}
        </span>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={rejected ? true : undefined}
          aria-describedby={hasLine ? statusId : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onWheel={blurOnWheel}
          className={INPUT_CLASS}
        />
      </label>
      <FieldStatusLine id={statusId} status={status} />
    </div>
  );
}
