// The projector clock's text (#543 P2). Same scoring-window rule as
// outsideScoringWindow: no (or an unparseable) start means not launched (#464).
import { describe, expect, it } from "vitest";
import { clockText } from "@/lib/display-clock";

const START = "2026-10-03T13:00:00.000Z";
const END = "2026-10-03T21:00:00.000Z";
const at = (iso: string) => Date.parse(iso);

describe("clockText", () => {
  it("says not launched with no start, or an unparseable one", () => {
    expect(clockText(at(START), null, END)).toBe("not launched");
    expect(clockText(at(START), "", END)).toBe("not launched");
    expect(clockText(at(START), "soon", END)).toBe("not launched");
  });

  it("counts down to the start in HH:MM:SS within a day", () => {
    expect(clockText(at("2026-10-03T10:45:53.000Z"), START, END)).toBe("starts in 02:14:07");
    expect(clockText(at("2026-10-03T12:59:59.000Z"), START, END)).toBe("starts in 00:00:01");
  });

  it("switches to days and hours when more than a day out", () => {
    expect(clockText(at("2026-09-30T09:00:00.000Z"), START, END)).toBe("starts in 3d 04h");
    expect(clockText(at("2026-10-02T13:00:00.000Z"), START, END)).toBe("starts in 1d 00h");
  });

  it("is live from the start instant itself", () => {
    expect(clockText(at(START), START, END)).toBe("ends in 08:00:00");
  });

  it("counts down to the end while live", () => {
    expect(clockText(at("2026-10-03T17:47:16.000Z"), START, END)).toBe("ends in 03:12:44");
  });

  it("says nothing extra while live with no end", () => {
    expect(clockText(at("2026-10-03T17:00:00.000Z"), START, null)).toBe("");
  });

  it("is still live at the end instant, and final after it", () => {
    expect(clockText(at(END), START, END)).toBe("ends in 00:00:00");
    expect(clockText(at(END) + 1, START, END)).toBe("final");
  });

  it("ignores an unparseable end like outsideScoringWindow does", () => {
    expect(clockText(at("2026-10-03T17:00:00.000Z"), START, "later")).toBe("");
  });
});
