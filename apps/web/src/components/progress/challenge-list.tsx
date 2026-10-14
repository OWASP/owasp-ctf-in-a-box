"use client";

// The expanded list inside a ProgressRow: what is left to do in a target or a
// module, ordered so the next thing worth doing is at the top.
//
// An expanded target used to be 38–110 flat rows in catalogue order, where the
// open rows (the ones a contestant can still act on) were outnumbered and
// visually outweighed by the ones already done. Here the rows group by the
// OWASP category the data already carries, groups sort by the points still on
// the table, done rows sink within their group, and a long group hides them
// behind a toggle.
//
// Client Component for the per-group toggle only; every number arrives as a
// prop. Items are built FIELD BY FIELD by the caller from public records —
// never a spread of a store row, which is what keeps a flag or an answer key
// out of this markup.

import { useState } from "react";
import OwaspBadge from "@/components/owasp-badge";
import ProgressRow from "@/components/progress/progress-row";

/** How large a group has to get before the done rows are worth collapsing.
 *  Below this the toggle costs more attention than the rows it hides. */
export const COLLAPSE_ABOVE = 10;

export type ProgressItem = {
  key: string;
  name: string;
  points: number;
  done: boolean;
  /** The status word, always rendered: status is never carried by colour
   *  alone. "Patched" / "Solved" / "Open" / "Not attempted". */
  status: string;
  /** Which of the three status colours the dot and word take. */
  tone: "done" | "open" | "unknown";
  /** OWASP code ("A01") or a classic category ("Web"); null when the module
   *  has no grouping of its own — quiz and ai. */
  group?: string | null;
};

type ItemGroup = {
  /** null for an ungrouped module: one anonymous bucket, no headers. */
  name: string | null;
  items: ProgressItem[];
  /** Points still on the table here — what the group order is decided by. */
  openPoints: number;
  earnedPoints: number;
  maxPoints: number;
  doneCount: number;
};

const TONE: Record<ProgressItem["tone"], string> = {
  done: "#22c55e",
  open: "#e53e3e",
  unknown: "#8f8f9b",
};

/** Groups, ordered by the points a contestant can still win in each; within a
 *  group the done rows sink to the bottom, everything else keeps catalogue
 *  order. Both sorts are stable, so equal groups (and equal rows) stay in the
 *  order the caller supplied rather than shuffling between renders. */
export function groupItems(items: ProgressItem[]): ItemGroup[] {
  const buckets = new Map<string | null, ProgressItem[]>();
  for (const item of items) {
    const key = item.group ?? null;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const groups: ItemGroup[] = [...buckets].map(([name, rows]) => {
    const open = rows.filter((r) => !r.done);
    const done = rows.filter((r) => r.done);
    return {
      name,
      items: [...open, ...done],
      openPoints: open.reduce((n, r) => n + r.points, 0),
      earnedPoints: done.reduce((n, r) => n + r.points, 0),
      maxPoints: rows.reduce((n, r) => n + r.points, 0),
      doneCount: done.length,
    };
  });
  return groups.sort((a, b) => b.openPoints - a.openPoints);
}

function Row({ item }: { item: ProgressItem }) {
  const colour = TONE[item.tone];
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: colour }} aria-hidden="true" />
      <span className={`min-w-0 flex-1 truncate ${item.done ? "text-muted" : "text-zinc-300"}`}>{item.name}</span>
      {item.group && /^(A|API)\d/.test(item.group) && <OwaspBadge code={item.group} />}
      <span className="flex-none font-mono text-xs text-muted">{item.points}pt</span>
      <span className="w-24 flex-none text-right text-xs uppercase tracking-wide" style={{ color: colour }}>
        {item.status}
      </span>
    </li>
  );
}

function Group({ group, doneWord, unit }: { group: ItemGroup; doneWord: string; unit: string }) {
  const collapsible = group.items.length > COLLAPSE_ABOVE && group.doneCount > 0;
  const [showDone, setShowDone] = useState(false);
  const visible = collapsible && !showDone ? group.items.filter((i) => !i.done) : group.items;
  return (
    <div className="border-l border-white/[0.06] pl-3">
      {group.name && (
        <ProgressRow
          label={group.name}
          level="target"
          done={group.doneCount}
          total={group.items.length}
          unit={unit}
          earned={group.earnedPoints}
          max={group.maxPoints}
        />
      )}
      <ul className="flex flex-col">
        {visible.map((item) => (
          <Row key={item.key} item={item} />
        ))}
      </ul>
      {collapsible && (
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          aria-expanded={showDone}
          className="mt-1 text-xs text-zinc-400 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
        >
          {showDone ? "Hide" : "Show"} {doneWord} ({group.doneCount})
        </button>
      )}
    </div>
  );
}

export default function ChallengeList({
  items,
  unit,
  doneWord,
}: {
  items: ProgressItem[];
  /** The module's unit word, for the group headers' fractions. */
  unit: string;
  /** What the toggle calls the rows it hides: "patched", "answered". */
  doneWord: string;
}) {
  if (items.length === 0) return null;
  const groups = groupItems(items);
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <Group key={group.name ?? "_"} group={group} doneWord={doneWord} unit={unit} />
      ))}
    </div>
  );
}
