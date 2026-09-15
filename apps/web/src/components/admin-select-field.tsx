"use client";

// The one fixed-choice settings control, alongside AdminNumberField (a typed
// number) and AdminSwitch (on/off). A select's change is already a final
// value — unlike a number field there is no partial-typing state to debounce
// through a blur-commit, so `onChange` posts straight through, the same way
// AdminSwitch's does.
//
// Presentational, like its siblings: the shell owns the value, the write and
// the per-row `status` it derives from that write; this renders the row and
// the three states beside it — "Saving…", "Saved", or the reason it was
// refused — through the same `FieldStatusLine` the other two field kinds use,
// so every field in the panel reports a save in exactly the same words,
// colour and place.

import type { ReactNode } from "react";
import { FieldStatusLine, type FieldStatus } from "./admin-number-field";

const SELECT_CLASS =
  "flex-none rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] aria-[invalid=true]:border-[#e53e3e]/70";

export default function AdminSelectField<T extends string>({
  id,
  label,
  help,
  value,
  options,
  disabled,
  status,
  onChange,
}: {
  /** Stable id; the status line is `${id}-status` and the select points at it. */
  id: string;
  label: string;
  help?: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled: boolean;
  status: FieldStatus;
  /** Called with the option the organizer picked. The shell decides what
   *  happens next and reports back through `status`; this component never
   *  applies the choice itself. */
  onChange: (next: T) => void;
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
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={rejected ? true : undefined}
          aria-describedby={hasLine ? statusId : undefined}
          onChange={(e) => onChange(e.target.value as T)}
          className={SELECT_CLASS}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <FieldStatusLine id={statusId} status={status} />
    </div>
  );
}
