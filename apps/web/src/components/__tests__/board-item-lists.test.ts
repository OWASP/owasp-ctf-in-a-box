// The hidden-steps line under a row's flag list (#584). A story step locked
// for the viewer arrives as a placeholder with nothing per position (ADR 60);
// the route reports only how many of them the row's team solved. The line
// gives that count and their point total, derived as the row's own Jeopardy
// points minus the visible solved items — a figure the row already makes
// derivable, so it reveals no single step's value.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hiddenSummary, mergeHiddenSolved } from "../board-item-lists";

const visible = (id: string, earned: number) => ({ id, label: id, points: earned, done: true, earnedPoints: earned });
const hidden = (n: number) => ({ id: `locked:op:${n}`, label: `??? — step ${n} of 8`, points: 0, done: false, hidden: true as const });

describe("hiddenSummary", () => {
  it("gives the count and derives the total from the row", () => {
    // The RTS row: 1,800 Jeopardy points, 250 of them on visible flags.
    const items = [visible("v1", 50), visible("v2", 100), visible("v3", 100), ...[2, 3, 4, 5, 6, 7, 8].map(hidden)];
    expect(hiddenSummary(5, items, 1800)).toBe("5 hidden steps solved · 1,550 pts");
  });

  it("speaks in the singular for one step", () => {
    expect(hiddenSummary(1, [visible("v1", 50), hidden(2)], 200)).toBe("1 hidden step solved · 150 pts");
  });

  it("leaves the total off when the row's points are unknown", () => {
    expect(hiddenSummary(1, [hidden(2)], undefined)).toBe("1 hidden step solved");
  });

  it("never shows a negative total", () => {
    expect(hiddenSummary(1, [visible("v1", 300), hidden(2)], 200)).toBe("1 hidden step solved");
  });

  it("says nothing when no hidden step is solved", () => {
    expect(hiddenSummary(0, [visible("v1", 50), hidden(2)], 50)).toBeNull();
  });
});

// A roster over the route's 8-login cap is fetched in chunks, each counting the
// hidden steps ITS members hold; one step held in two chunks would count twice
// if summed. The larger chunk count is a floor that never over-claims.
describe("mergeHiddenSolved", () => {
  it("takes the largest chunk count, never the sum", () => {
    expect(mergeHiddenSolved([3, 2])).toBe(3);
  });

  it("reads a missing count as 0", () => {
    expect(mergeHiddenSolved([undefined, 1])).toBe(1);
    expect(mergeHiddenSolved([])).toBe(0);
  });
});
