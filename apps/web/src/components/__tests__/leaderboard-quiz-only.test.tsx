// The leaderboard on an event that does NOT run secure-development.
//
// "patched" and "non-patched" are that module's own vocabulary: a regression
// test passing against a submitted patch. /profile already gated the identical
// trio on `secureDevEnabled`; the board rendered its two columns and the
// "patched" sort key unconditionally, so a quiz-only event — the one event
// /leaderboard's acceptance gate actually loads — showed every contestant a
// "0 patched / 0 non-patched" pair for a game it wasn't running, and offered
// to sort on it.
//
// Own file so the quiz-only `modules` fixture can't be confused with
// leaderboard.test.tsx's two-module one or leaderboard-single-module.test.tsx's
// secure-development one.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={(props.alt as string) ?? ""} />;
  },
}));

import Leaderboard, { EntryRow } from "@/components/leaderboard";
import type { ResolvedModule } from "@/lib/modules";
import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard/types";

const QUIZ_ONLY: readonly ResolvedModule[] = [
  { id: "quiz", title: "Quiz", blurb: "" },
];
const WITH_SECURE_DEV: readonly ResolvedModule[] = [
  { id: "secure-development", title: "Secure Development", blurb: "" },
];

const CAPS = { apps: false, teams: false, challenges: false } as const;

// A row as `withModuleContributions` creates one for a quiz-only contestant:
// real points, and zeroes in every field the scorer would have filled in.
const entry: LeaderboardEntry = {
  rank: 1,
  login: "alice",
  team: null,
  points: 30,
  patched: 0,
  failed: 0,
  total: 0,
  apps: {},
  updatedAt: null,
  modules: {
    quiz: {
      points: 30,
      completed: 2,
      lastActivityAt: null,
      detail: { kind: "quiz", answered: 2, total: 4, points: 30 },
    },
  },
};

const data: LeaderboardData = {
  entries: [entry],
  teams: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: CAPS,
};

describe("a leaderboard row on a quiz-only event", () => {
  const html = renderToStaticMarkup(
    <EntryRow
      entry={entry}
      topPoints={30}
      isOwn={false}
      isOpen={false}
      onToggle={() => {}}
      capabilities={CAPS}
      modules={QUIZ_ONLY}
      enabledApps={[]}
    />,
  );

  it("renders no patched or non-patched column", () => {
    expect(html).not.toContain("patched");
  });

  it("still renders the contestant and their points", () => {
    expect(html).toContain("alice");
    expect(html).toContain("30");
  });
});

describe("a leaderboard row on a secure-development event", () => {
  // The row used to carry a `patched` + `non-patched` pair. They always summed
  // to the catalogue, so the second was pure restatement of the first — and
  // NEITHER was the figure the board ordered by, which is what made rows like
  // "1,061 pts at rank 3, above 550 pts at rank 1" unexplainable on screen.
  // One `solved` column replaced both, showing the comparator's own count.
  it("shows one solved column, not the old patched/non-patched pair", () => {
    const html = renderToStaticMarkup(
      <EntryRow
        entry={{ ...entry, patched: 3, total: 5 }}
        topPoints={30}
        isOwn={false}
        isOpen={false}
        onToggle={() => {}}
        capabilities={CAPS}
        modules={WITH_SECURE_DEV}
        enabledApps={[]}
      />,
    );
    expect(html).toContain(">solved<");
    expect(html).not.toContain(">non-patched<");
  });
});

describe("the solved column", () => {
  function render(props: Partial<Parameters<typeof EntryRow>[0]> = {}) {
    return renderToStaticMarkup(
      <EntryRow
        entry={entry}
        topPoints={30}
        isOwn={false}
        isOpen={false}
        onToggle={() => {}}
        capabilities={CAPS}
        modules={QUIZ_ONLY}
        enabledApps={[]}
        {...props}
      />,
    );
  }

  // The whole point of the column: it is the number `compareStanding` orders
  // on. This entry has 2 quiz completions and 0 patched.
  /** The rendered solved cell, as "<count>" or "<count> / <total>" — matched
   *  on the cell itself rather than on a bare number, which appears all over
   *  the row's markup (points, rank, avatar dimensions). */
  function solvedCell(html: string): string | null {
    const m = html.match(/text-\[#22c55e\]"?>(\d+)(?:<span[^>]*>\s*\/\s*(\d+)<\/span>)?/);
    if (!m) return null;
    return m[2] ? `${m[1]} / ${m[2]}` : m[1];
  }

  // On a quiz-only event (no classic module), the solved column shows a bare
  // count since there's no story-lock reachable denominator to display.
  it("shows a bare count when no classic module is enabled", () => {
    expect(solvedCell(render({}))).toBe("2");
  });
});

describe("the sort controls on a quiz-only event", () => {
  // No "rank" key since #522: the standing order IS points first, so a
  // separate "rank" sort would repeat "points".
  it("offers points but not rank or patched", () => {
    const html = renderToStaticMarkup(
      <Leaderboard data={data} viewerLogin={null} modules={QUIZ_ONLY} enabledApps={[]} />,
    );
    expect(html).not.toContain(">rank<");
    expect(html).toContain(">points<");
    expect(html).not.toContain("patched");
  });

  // The third key used to be "patched" and was hidden on a quiz-only event,
  // because it sorted a column that event did not have. It sorts on
  // cross-module completion now, which every event has — so the gate went
  // away with the column it was protecting.
  it("offers the solved sort on a quiz-only event too", () => {
    const html = renderToStaticMarkup(
      <Leaderboard data={data} viewerLogin={null} modules={QUIZ_ONLY} enabledApps={[]} />,
    );
    expect(html).toContain(">solved<");
  });

  it("offers the same two keys where secure-development is enabled", () => {
    const html = renderToStaticMarkup(
      <Leaderboard data={data} viewerLogin={null} modules={WITH_SECURE_DEV} enabledApps={[]} />,
    );
    expect(html).not.toContain(">rank<");
    expect(html).toContain(">points<");
    expect(html).toContain(">solved<");
  });
});
