"use client";

// The quiz/classic/ai Show-N item lists for an EXPANDED leaderboard row —
// which questions a contestant answered, which flags a team has solved,
// which ai challenges are done. Per-item data isn't in the board payload
// (embedding it for every row would bloat a no-store page nobody has
// expanded), so this fetches from /api/board/items on mount — i.e. on
// expand — and renders the same ModuleItemList the profile blocks use.
// Renders nothing until the data lands and nothing at all on failure: this
// is detail, never a gate.

import { useEffect, useState } from "react";
import ModuleItemList, { type ModuleItem } from "@/components/module-item-list";

type ItemsResponse = {
  quiz: ModuleItem[] | null;
  classic: ModuleItem[] | null;
  ai: ModuleItem[] | null;
  /** How many story steps hidden from the viewer the queried logins solved —
   *  one count, nothing per position (ADR 60). */
  classicHiddenSolved?: number;
};

/** The route unions at most 8 logins per request (its anti-scrape cap), but
 *  an organizer can raise the team size well past that — chunk the roster
 *  and union the responses client-side so a big team's lists don't silently
 *  400 away. */
const CHUNK = 8;

function mergeItems(parts: (ModuleItem[] | null)[]): ModuleItem[] | null {
  const lists = parts.filter((p): p is ModuleItem[] => p !== null);
  if (lists.length === 0) return null;
  const merged = new Map<string, ModuleItem>();
  for (const list of lists) {
    for (const item of list) {
      const seen = merged.get(item.id);
      // done wins, and the first banked points ride along with it.
      if (!seen || (!seen.done && item.done)) merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

/** A roster over the route's 8-login cap arrives in chunks, each counting the
 *  hidden steps its own members hold. A step held in two chunks would count
 *  twice if summed, so the largest chunk count is used: a floor that never
 *  over-claims. */
export function mergeHiddenSolved(counts: readonly (number | undefined)[]): number {
  return counts.reduce<number>((max, c) => Math.max(max, c ?? 0), 0);
}

/** The line under a row's flag list for the story steps hidden from this
 *  viewer that the row's team solved (#584). The route sends only their
 *  count (ADR 60), so their total is the row's own Jeopardy points minus the
 *  visible solved items — derivable from the row already, so no single
 *  step's value is revealed. Without the row's points, or if the subtraction
 *  comes out negative (a re-priced item), the total is left off rather than
 *  guessed. */
export function hiddenSummary(
  solved: number,
  items: readonly ModuleItem[],
  rowPoints: number | undefined,
): string | null {
  if (solved <= 0) return null;
  const noun = solved === 1 ? "hidden step" : "hidden steps";
  const visible = items
    .filter((i) => !i.hidden && i.done)
    .reduce((sum, i) => sum + (i.earnedPoints ?? i.points), 0);
  const total = rowPoints === undefined ? null : rowPoints - visible;
  return total !== null && total > 0
    ? `${solved} ${noun} solved · ${total.toLocaleString("en-US")} pts`
    : `${solved} ${noun} solved`;
}

export default function BoardItemLists({
  logins,
  classicPoints,
}: {
  logins: string[];
  /** The row's gross Jeopardy points, for the hidden-steps total. */
  classicPoints?: number;
}) {
  const [data, setData] = useState<ItemsResponse | null>(null);
  const key = logins.join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const all = key.split(",");
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK));
    Promise.all(
      chunks.map((chunk) =>
        fetch(`/api/board/items?logins=${encodeURIComponent(chunk.join(","))}`)
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null),
      ),
    ).then((parts: (ItemsResponse | null)[]) => {
      if (cancelled) return;
      const ok = parts.filter((p): p is ItemsResponse => p !== null);
      if (ok.length === 0 || ok.length !== chunks.length) return;
      setData({
        quiz: mergeItems(ok.map((p) => p.quiz)),
        classic: mergeItems(ok.map((p) => p.classic)),
        ai: mergeItems(ok.map((p) => p.ai)),
        classicHiddenSolved: mergeHiddenSolved(ok.map((p) => p.classicHiddenSolved)),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!data) return null;
  const quiz = data.quiz ?? [];
  const classic = data.classic ?? [];
  const ai = data.ai ?? [];
  if (quiz.length === 0 && classic.length === 0 && ai.length === 0) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {quiz.length > 0 && (
        <ModuleItemList items={quiz} noun={quiz.length === 1 ? "question" : "questions"} doneLabel="Answered" />
      )}
      {classic.length > 0 && (
        <ModuleItemList
          items={classic}
          noun={classic.length === 1 ? "flag" : "flags"}
          doneLabel="Solved"
          note={hiddenSummary(data.classicHiddenSolved ?? 0, classic, classicPoints)}
        />
      )}
      {ai.length > 0 && (
        <ModuleItemList items={ai} noun={ai.length === 1 ? "challenge" : "challenges"} doneLabel="Solved" />
      )}
    </div>
  );
}
