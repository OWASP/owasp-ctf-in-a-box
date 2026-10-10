// The hidden-steps line under a row's flag list (#584). A story step locked
// for the viewer arrives as a placeholder with no points (ADR 60), so the
// list alone cannot add up to the row. The line counts the hidden steps the
// team solved and gives their total as the row's own Jeopardy points minus
// the visible solved items — a figure the row already makes derivable, so it
// reveals no single step's value.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hiddenSummary } from "../board-item-lists";

const visible = (id: string, earned: number) => ({ id, label: id, points: earned, done: true, earnedPoints: earned });
const hidden = (n: number, done: boolean) => ({ id: `locked:op:${n}`, label: `??? — step ${n} of 8`, points: 0, done, hidden: true as const });

describe("hiddenSummary", () => {
  it("counts the hidden steps the team solved and derives their total from the row", () => {
    // The RTS row: 1,800 Jeopardy points, 250 of them on visible flags.
    const items = [visible("v1", 50), visible("v2", 100), visible("v3", 100), hidden(2, true), hidden(3, true), hidden(4, true), hidden(5, true), hidden(6, true), hidden(7, false), hidden(8, false)];
    expect(hiddenSummary(items, 1800)).toBe("5 hidden steps solved · 1,550 pts");
  });

  it("speaks in the singular for one step", () => {
    expect(hiddenSummary([visible("v1", 50), hidden(2, true)], 200)).toBe("1 hidden step solved · 150 pts");
  });

  it("leaves the total off when the row's points are unknown", () => {
    expect(hiddenSummary([hidden(2, true)], undefined)).toBe("1 hidden step solved");
  });

  it("never shows a negative total", () => {
    expect(hiddenSummary([visible("v1", 300), hidden(2, true)], 200)).toBe("1 hidden step solved");
  });

  it("says nothing when no hidden step is solved", () => {
    expect(hiddenSummary([visible("v1", 50), hidden(2, false)], 50)).toBeNull();
  });
});
