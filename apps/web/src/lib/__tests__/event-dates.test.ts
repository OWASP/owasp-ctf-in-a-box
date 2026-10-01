import { describe, expect, it } from "vitest";
import { formatDateRange } from "@/lib/event-dates";

describe("formatDateRange", () => {
  it("same day → one date", () => {
    expect(formatDateRange("2026-10-01T09:00:00Z", "2026-10-01T18:00:00Z")).toBe("Oct 1, 2026");
  });

  it("same year → 'Oct 1 – Oct 3, 2026'", () => {
    expect(formatDateRange("2026-10-01T09:00:00Z", "2026-10-03T18:00:00Z")).toBe(
      "Oct 1 – Oct 3, 2026",
    );
  });

  it("different years → both years", () => {
    expect(formatDateRange("2026-12-31T20:00:00Z", "2027-01-02T02:00:00Z")).toBe(
      "Dec 31, 2026 – Jan 2, 2027",
    );
  });

  it("start only → 'From Oct 1, 2026'", () => {
    expect(formatDateRange("2026-10-01T09:00:00Z", null)).toBe("From Oct 1, 2026");
  });

  it("end only → 'Until Oct 3, 2026'", () => {
    expect(formatDateRange(null, "2026-10-03T18:00:00Z")).toBe("Until Oct 3, 2026");
  });

  it("none or unparseable → ''", () => {
    expect(formatDateRange(null, null)).toBe("");
    expect(formatDateRange("nope", null)).toBe("");
  });

  // Pinning current behaviour, not endorsing it: `formatDateRange` trusts
  // its bounds and does no ordering check of its own. Whether `end < start`
  // should be refused is a setup-wizard/`doctor` concern (#386), NOT
  // validated here — this only documents what the renderer does today so a
  // future change is a deliberate diff against this test, not a surprise.
  it("end before start → renders the reversed range unchanged (not validated here)", () => {
    expect(formatDateRange("2026-10-05T09:00:00Z", "2026-10-01T18:00:00Z")).toBe(
      "Oct 5 – Oct 1, 2026",
    );
  });

  // A valid start with an end that fails to parse collapses to the
  // start-only case — same as an absent end (parseInstant treats malformed
  // and missing identically).
  it("valid start, unparseable end → 'From …'", () => {
    expect(formatDateRange("2026-10-01T09:00:00Z", "nope")).toBe("From Oct 1, 2026");
  });
});

// #547: the dates line follows the event's zone. Without one it stays UTC.
describe("formatDateRange in the event's zone", () => {
  it("prints the event's own calendar day, not UTC's", () => {
    // 01:00Z on Oct 2 is still Oct 1 in Buenos Aires (GMT-3).
    expect(formatDateRange("2026-10-02T01:00:00Z", null)).toBe("From Oct 2, 2026");
    expect(formatDateRange("2026-10-02T01:00:00Z", null, "America/Argentina/Buenos_Aires")).toBe("From Oct 1, 2026");
  });
  it("judges same-year by the event's calendar", () => {
    // Jan 1 01:00Z is Dec 31 in Buenos Aires: one year there, two in UTC.
    expect(formatDateRange("2026-12-30T12:00:00Z", "2027-01-01T01:00:00Z", "America/Argentina/Buenos_Aires")).toBe("Dec 30 – Dec 31, 2026");
  });
});
