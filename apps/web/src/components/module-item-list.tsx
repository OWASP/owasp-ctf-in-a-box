"use client";

// Collapsible per-item list for the app-side modules' profile blocks — the
// quiz and classic counterpart of AppChallengeList, so "which ones have I
// done" reads the same on every module: a Show/Hide toggle, then check-dot
// rows. Client Component because it's pure local expand/collapse state —
// collapsed by default, same as the target lists.
//
// Items are built FIELD BY FIELD by the caller from the public records
// (never a spread of a store row) — the same rule that keeps a flag or an
// answer key out of this markup.

import { useState } from "react";

export type ModuleItem = {
  id: string;
  /** The item's public label — a question's prompt, a challenge's title. */
  label: string;
  /** The sticker price. */
  points: number;
  done: boolean;
  /** What the viewer actually banked, when done — can differ from `points`
   *  if the item was re-priced after they completed it. */
  earnedPoints?: number;
  /** A story step redacted for this viewer: placeholder label, no price. */
  hidden?: true;
};

/** The row's points column: a dash for a hidden step, which carries no price
 *  (ADR 60) and must not read as worth 0; the banked points for a done item;
 *  the sticker price otherwise. */
export function itemPointsLabel(item: ModuleItem): string {
  if (item.hidden) return "—";
  return `${item.done && item.earnedPoints != null ? item.earnedPoints : item.points}pt`;
}

export default function ModuleItemList({
  items,
  noun,
  doneLabel,
  note,
}: {
  items: ModuleItem[];
  /** One line under the open list — the hidden-steps summary on a classic
   *  row. */
  note?: string | null;
  /** Plural item noun for the toggle: "questions", "flags". */
  noun: string;
  /** The done-state word: "Answered", "Solved". */
  doneLabel: string;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        <svg
          className={`transition-transform ${open ? "rotate-90" : ""}`}
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {open ? "Hide" : "Show"} {items.length} {noun}
      </button>

      {open && (
        <ul className="mt-2 flex flex-col gap-1 border-l border-white/[0.06] pl-3">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-1 text-sm">
              <span
                className={`h-1.5 w-1.5 flex-none rounded-full ${
                  item.done ? "bg-[#22c55e]" : "border border-[#8f8f9b]/50"
                }`}
                aria-hidden="true"
              />
              <span className={`min-w-0 flex-1 truncate ${item.done ? "text-muted" : "text-zinc-300"}`}>
                {item.label}
              </span>
              <span className="flex-none font-mono text-xs text-muted">
                {itemPointsLabel(item)}
              </span>
              <span
                className={`w-20 flex-none text-right text-xs uppercase tracking-wide ${
                  item.done ? "text-[#22c55e]" : "text-[#8f8f9b]"
                }`}
              >
                {item.done ? doneLabel : "Open"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && note && <p className="mt-1 pl-3 text-xs text-muted">{note}</p>}
    </div>
  );
}
