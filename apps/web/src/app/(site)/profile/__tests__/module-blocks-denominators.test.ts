// A progress row's two halves come from different places, and deleting a
// solved challenge splits them (issue #330).
//
// The numerator counts SOLVE RECORDS, which survive deletion on purpose — the
// admin delete dialog promises it: "Points already banked for it stay on the
// leaderboard." The denominator counts the LIVE CATALOGUE, which no longer has
// the challenge in it. So an organizer who deletes two solved AI challenges
// mid-event hands every affected contestant:
//
//     AI   5 / 5 cleared   870 / 850 pts
//
// with a bar filled past its own end, while the board they browse says 3 / 3.
//
// Clamping the totals stops the ratio exceeding one but is not the union, and
// the difference is visible: five live items with three solved, two unsolved
// and two solved-then-deleted is 5 / 7, where a clamp reports 5 / 5 and calls a
// module finished that still has two challenges waiting. These pin the union,
// for every module and both halves of the row.
import { describe, expect, it } from "vitest";
import { moduleRow, remainingFor } from "@/app/(site)/profile/module-blocks";
import type { ProfileModuleInput } from "@/app/(site)/profile/module-blocks";
import type { ModuleProgress } from "@/lib/leaderboard/types";
import type { ResolvedModule } from "@/lib/modules";
import { remainingSummary } from "@/components/progress/remaining-line";

// Five LIVE items worth 100 each. The viewer solved three of them, and two
// more that an organizer has since deleted — so two live items are still
// unsolved and two banked solves have no live challenge behind them.
//
// The union is 7 items / 700 pts, and only an identity-aware count reaches it:
// max(liveTotal, solved) caps at 5 / 5, which tells a contestant they have
// finished a module that still has two challenges waiting.
const LIVE = [1, 2, 3, 4, 5].map((n) => ({ id: `live-${n}`, points: 100 }));
const SOLVED = {
  "live-1": { points: 100, at: "t" },
  "live-2": { points: 100, at: "t" },
  "live-3": { points: 100, at: "t" },
  "deleted-1": { points: 100, at: "t" },
  "deleted-2": { points: 100, at: "t" },
};
const DONE = 5;
const BANKED_POINTS = 500;
const UNION_ITEMS = 7;
const UNION_POINTS = 700;

const input = {
  profile: { points: BANKED_POINTS, maxPoints: 500 },
  appsRecord: {},
  challengeCount: 5,
  enabledMaxPoints: 500,
  secureDev: true,
  quiz: { questions: LIVE, maxPoints: 500, viewer: { answered: SOLVED, attempts: {} } },
  classic: { challenges: LIVE, maxPoints: 500, viewer: { solved: SOLVED, attempts: {} } },
  ai: { challenges: LIVE, maxPoints: 500, viewer: { solved: SOLVED, attempts: {} } },
} as unknown as ProfileModuleInput;

const progressFor = (detail: ModuleProgress["detail"]): ModuleProgress =>
  ({ points: BANKED_POINTS, completed: DONE, detail }) as unknown as ModuleProgress;

const cases = [
  ["quiz", { kind: "quiz", answered: DONE, total: 5 }],
  ["classic", { kind: "classic", solved: DONE, total: 5 }],
  ["ai", { kind: "ai", solved: DONE, total: 5 }],
] as unknown as Array<[string, ModuleProgress["detail"]]>;

describe("a progress row counts the live-and-historical union", () => {
  for (const [name, detail] of cases) {
    it(`${name}: deleted-but-solved items are ADDED to the live denominator`, () => {
      const row = moduleRow(progressFor(detail), input);
      expect(row.done).toBe(DONE);
      // 5 / 7, not 5 / 5: two live items are still unsolved.
      expect(row.total).toBe(UNION_ITEMS);
      expect(row.total).toBeGreaterThan(row.done);
    });

    it(`${name}: points banked on a deleted challenge are added too`, () => {
      const row = moduleRow(progressFor(detail), input);
      expect(row.earned).toBe(BANKED_POINTS);
      // "500 / 700 pts" — the deleted pair's value comes from the solve
      // record, which is the only place a deleted challenge still has one.
      expect(row.max).toBe(UNION_POINTS);
      expect(row.max).toBeGreaterThanOrEqual(row.earned);
    });

    it(`${name}: an untouched catalogue keeps its own denominators`, () => {
      // The union must not inflate a row with nothing deleted behind it.
      const clean = {
        ...input,
        quiz: { questions: LIVE, maxPoints: 500, viewer: { answered: { "live-1": { points: 100, at: "t" } }, attempts: {} } },
        classic: { challenges: LIVE, maxPoints: 500, viewer: { solved: { "live-1": { points: 100, at: "t" } }, attempts: {} } },
        ai: { challenges: LIVE, maxPoints: 500, viewer: { solved: { "live-1": { points: 100, at: "t" } }, attempts: {} } },
      } as unknown as ProfileModuleInput;
      const row = moduleRow(
        { points: 100, completed: 1, detail: { ...(detail as object), ...oneSolved(detail) } } as unknown as ModuleProgress,
        clean,
      );
      expect(row.total).toBe(5);
      expect(row.max).toBe(500);
    });
  }

  it("secure-development clamps instead, having no per-item identity here", () => {
    // Its catalogue is baked from the rubrics, so it cannot gain a
    // deleted-but-solved challenge — but dropping a TARGET shrinks the ceiling
    // while the banked patch count stays.
    const row = moduleRow(
      { points: BANKED_POINTS, completed: 8, detail: { kind: "secure-development" } } as unknown as ModuleProgress,
      { ...input, challengeCount: 3, profile: { points: BANKED_POINTS, maxPoints: 10 } } as unknown as ProfileModuleInput,
    );
    expect(row.total).toBeGreaterThanOrEqual(row.done);
    expect(row.max).toBeGreaterThanOrEqual(row.earned);
  });
});

/** The one-solve counterpart of a case's detail, for the untouched-catalogue
 *  check above. */
function oneSolved(detail: ModuleProgress["detail"]): Record<string, number> {
  return (detail as { kind: string }).kind === "quiz" ? { answered: 1, total: 5 } : { solved: 1, total: 5 };
}

// The footer sits directly under the rows above, so it has to be counting the
// same things. #330 moved `moduleRow` and the header ceiling onto the union
// and left `remainingFor` on the live-only `maxPoints` (issue #343), which
// showed as one page saying both "500 / 700 pts" and "0 pts still on the
// board" — a module the contestant had not finished, reported as finished.
describe("the footer's remaining line counts the same union as the rows", () => {
  // The same 5-live / 2-deleted shape, with each module's banked total filled
  // in: 500 of a 700-point union earned, so 200 per module is still winnable.
  const withTotals = {
    ...input,
    quiz: { ...(input.quiz as object), total: { points: BANKED_POINTS } },
    classic: { ...(input.classic as object), total: { points: BANKED_POINTS } },
    ai: { ...(input.ai as object), total: { points: BANKED_POINTS } },
  } as unknown as ProfileModuleInput;

  const modules = [
    { id: "quiz", title: "Quiz" },
    { id: "classic", title: "Jeopardy" },
    { id: "ai", title: "AI" },
  ] as unknown as ResolvedModule[];

  it("carries the union ceiling, not the live-only maxPoints", () => {
    for (const m of remainingFor(modules, withTotals)) {
      expect(m.max).toBe(UNION_POINTS);
      expect(m.earned).toBe(BANKED_POINTS);
    }
  });

  it("agrees with the row above it, module for module", () => {
    // The defect made visible: the row's max and the footer's max are two
    // readings of one number, and they must not differ.
    for (const [name, detail] of cases) {
      const row = moduleRow(progressFor(detail), withTotals);
      const footer = remainingFor(modules, withTotals).find((m) =>
        m.title.toLowerCase().startsWith(name === "classic" ? "jeopardy" : name),
      );
      expect(footer, name).toBeDefined();
      expect(footer!.max, name).toBe(row.max);
    }
  });

  it("still reports the 200 pts per module that are genuinely left", () => {
    // Pre-fix this summed to 0 and the line hid itself entirely, telling a
    // contestant with six unsolved items that the board was cleared.
    const { remaining } = remainingSummary(remainingFor(modules, withTotals));
    expect(remaining).toBe(3 * (UNION_POINTS - BANKED_POINTS));
  });

  it("secure-development is clamped, never below its banked points", () => {
    const rows = remainingFor(
      [{ id: "secure-development", title: "Secure Development" }] as unknown as ResolvedModule[],
      { ...input, profile: { points: 800, maxPoints: 500 } } as unknown as ProfileModuleInput,
    );
    expect(rows).toHaveLength(1);
    // A dropped target shrinks the ceiling under banked points; clamping keeps
    // the remainder at 0 rather than letting −300 eat another module's.
    expect(rows[0].max).toBe(800);
    expect(remainingSummary(rows).remaining).toBe(0);
  });
});
