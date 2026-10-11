// /admin → Support → Score adjustments (#591): the ledger an organizer adds
// to and removes from. Static render with seeded rows (no DOM in this suite):
// what each row says, and the empty state.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminAdjustments, { adjustmentRow } from "@/app/(site)/admin/admin-adjustments";

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
