// /admin → Support → Score adjustments (#591): the ledger an organizer adds
// to and removes from. Static render with seeded rows (no DOM in this suite):
// what each row says, and the empty state.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminAdjustments, { adjustmentRow, parseAdjustmentPoints } from "@/app/(site)/admin/admin-adjustments";

const ROW = { id: "a1", slug: "red-team", points: -10, reason: "late flag sharing", by: "alice", at: "2026-10-09T17:00:00.000Z" };

describe("AdminAdjustments", () => {
  it("describes a row: team, signed points, reason, who", () => {
    expect(adjustmentRow(ROW)).toBe("red-team −10 · late flag sharing · by alice");
    expect(adjustmentRow({ ...ROW, points: 50, reason: "bug report" })).toBe("red-team +50 · bug report · by alice");
  });

  it("lists every row with a remove control", () => {
    const html = renderToStaticMarkup(<AdminAdjustments initial={[ROW]} />);
    expect(html).toContain("Score adjustments");
    expect(html).toContain("late flag sharing");
    expect(html).toContain('aria-label="Remove adjustment for red-team"');
  });

  it("says when there are none", () => {
    expect(renderToStaticMarkup(<AdminAdjustments initial={[]} />)).toContain("No adjustments yet.");
  });
});

// The form enables Add only for a value the server accepts, so an organizer
// never gets a 400 for something the field let them type.
describe("parseAdjustmentPoints", () => {
  it.each([
    ["50", 50],
    ["-10", -10],
    ["+20", 20],
    [" 15 ", 15],
    ["100000", 100000],
    ["-100000", -100000],
  ])("accepts %j as %d", (text, points) => {
    expect(parseAdjustmentPoints(text)).toBe(points);
  });

  it.each(["", "   ", "0", "-0", "1e3", "1.5", "0x10", "abc", "100001", "-100001", "200000"])("refuses %j", (text) => {
    expect(parseAdjustmentPoints(text)).toBeNull();
  });
});
