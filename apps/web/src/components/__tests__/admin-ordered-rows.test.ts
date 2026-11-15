// The ordered-list arithmetic the quiz and classic admin panels share:
// sorting by `order`, upserting one row, the next free position, and the
// drag/keyboard reorder that renumbers from list position. The quiz and
// classic panels used to carry copies differing only in whether a row's
// public half lives at `.question` or `.challenge`; the accessors triple is
// that difference, and these tests pin the arithmetic once.
import { describe, expect, it } from "vitest";
import {
  type RowAccessors,
  changedOrderRows,
  nextOrder,
  reorderRows,
  sortByOrder,
  upsertRow,
} from "@/components/admin/ordered-rows";

type Row = { item: { id: string; order: number }; secret: string };

const rows: RowAccessors<Row> = {
  id: (r) => r.item.id,
  order: (r) => r.item.order,
  withOrder: (r, order) => ({ ...r, item: { ...r.item, order } }),
};

const a: Row = { item: { id: "a", order: 1 }, secret: "sa" };
const b: Row = { item: { id: "b", order: 2 }, secret: "sb" };
const c: Row = { item: { id: "c", order: 3 }, secret: "sc" };

describe("sortByOrder", () => {
  it("sorts by order, then id, and never mutates the input", () => {
    const input = [c, { ...a, item: { id: "z", order: 1 } }, a, b];
    const out = sortByOrder(input, rows);
    expect(out.map((r) => r.item.id)).toEqual(["a", "z", "b", "c"]);
    expect(input[0]).toBe(c);
  });
});

describe("upsertRow", () => {
  it("replaces the row with the same id and keeps the list sorted", () => {
    const edited: Row = { item: { id: "b", order: 0 }, secret: "new" };
    expect(upsertRow([a, b, c], edited, rows).map((r) => r.item.id)).toEqual(["b", "a", "c"]);
  });

  it("appends a new id", () => {
    expect(upsertRow([a], b, rows)).toEqual([a, b]);
  });
});

describe("nextOrder", () => {
  it("is one past the highest stored order", () => {
    expect(nextOrder([a, c], rows)).toBe(4);
  });

  it("is 1 for an empty list", () => {
    expect(nextOrder([], rows)).toBe(1);
  });
});

describe("reorderRows", () => {
  it("moves a row down and renumbers every position from 1", () => {
    const out = reorderRows([a, b, c], 0, 2, rows);
    expect(out.map((r) => [r.item.id, r.item.order])).toEqual([
      ["b", 1],
      ["c", 2],
      ["a", 3],
    ]);
  });

  it("moves a row up and renumbers every position from 1", () => {
    const out = reorderRows([a, b, c], 2, 0, rows);
    expect(out.map((r) => [r.item.id, r.item.order])).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
  });

  it("renumbers a list whose stored orders were sparse or zero-based", () => {
    const sparse = [
      { ...a, item: { id: "a", order: 0 } },
      { ...b, item: { id: "b", order: 5 } },
      { ...c, item: { id: "c", order: 9 } },
    ];
    expect(reorderRows(sparse, 1, 1, rows).map((r) => r.item.order)).toEqual([1, 2, 3]);
  });

  it("returns rows whose order is already right BY REFERENCE, so only moved rows are written back", () => {
    const out = reorderRows([a, b, c], 1, 2, rows);
    expect(out[0]).toBe(a);
    expect(out[1]).not.toBe(c);
    expect(out[1].secret).toBe("sc");
  });

  it("never mutates the list it was given", () => {
    const input = [a, b, c];
    reorderRows(input, 0, 2, rows);
    expect(input.map((r) => r.item.order)).toEqual([1, 2, 3]);
    expect(input[0]).toBe(a);
  });

  it("treats an out-of-range index as a no-op copy rather than a silent renumbering", () => {
    const sparse = [{ ...a, item: { id: "a", order: 4 } }, b];
    const out = reorderRows(sparse, 0, 5, rows);
    expect(out).toEqual(sparse);
    expect(out).not.toBe(sparse);
    expect(reorderRows(sparse, -1, 0, rows)).toEqual(sparse);
  });
});

describe("changedOrderRows", () => {
  it("names exactly the rows whose order differs, matched by id not position", () => {
    const before = [a, b, c];
    const after = reorderRows(before, 2, 0, rows);
    expect(changedOrderRows(before, after, rows).map((r) => r.item.id)).toEqual(["c", "a", "b"]);
    const nudge = reorderRows(before, 1, 2, rows);
    expect(changedOrderRows(before, nudge, rows).map((r) => r.item.id)).toEqual(["c", "b"]);
  });

  it("is empty when nothing moved, so a no-op drag writes nothing", () => {
    expect(changedOrderRows([a, b], [a, b], rows)).toEqual([]);
  });
});
