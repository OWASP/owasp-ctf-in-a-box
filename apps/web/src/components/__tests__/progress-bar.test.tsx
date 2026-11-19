// The shared bar. What matters here is not the pixels but the three rules the
// rest of the tree relies on: it measures POINTS, it degrades to the item
// count when a source carries no point data, and it never renders a fill so
// small that real progress looks like none.
//
// @testing-library/react is not a dependency of this repo and must not be
// added for a test — the bar is pure props, so `renderToStaticMarkup` sees
// exactly what a contestant's browser gets.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProgressBar, { MIN_FILL_PX, barReading, fillPercent, fillStyle } from "@/components/progress/progress-bar";

describe("barReading", () => {
  it("reads points when the source has them", () => {
    expect(barReading(141, 668, 5, 38)).toEqual({ value: 141, ceiling: 668, fellBack: false });
  });

  it("falls back to the item count when max is 0, rather than dividing by it", () => {
    // The lambda source reports maxPoints 0 for a target with no catalogue.
    // Reading points there would render every bar empty AND advertise "/ 0".
    expect(barReading(8, 0, 6, 321)).toEqual({ value: 6, ceiling: 321, fellBack: true });
  });

  it("still falls back when there is nothing at all to show", () => {
    expect(barReading(0, 0, 0, 0)).toEqual({ value: 0, ceiling: 0, fellBack: true });
  });
});

describe("fillPercent", () => {
  it("is the plain ratio in the ordinary case", () => {
    expect(fillPercent(50, 200)).toBe(25);
  });

  it("clamps at 100 — banked points survive a deleted item, so value can exceed the ceiling", () => {
    expect(fillPercent(300, 200)).toBe(100);
  });

  it("is 0 for an empty or absent ceiling instead of NaN or Infinity", () => {
    expect(fillPercent(5, 0)).toBe(0);
    expect(fillPercent(0, 100)).toBe(0);
  });
});

describe("fillStyle", () => {
  it("gives a zero value no minimum width", () => {
    expect(fillStyle(0, 0)).toEqual({ width: "0%", minWidth: 0 });
  });

  it("floors a nonzero value's sliver at MIN_FILL_PX, however small the percentage", () => {
    // 2 of 3,943 pts is 0.05% — a fraction of a device pixel unfloored.
    expect(fillStyle(0.05, 2)).toEqual({ width: "0.05%", minWidth: MIN_FILL_PX });
  });

  it("reports the full width at 100, still with the floor since the value is nonzero", () => {
    expect(fillStyle(100, 200)).toEqual({ width: "100%", minWidth: MIN_FILL_PX });
  });
});

describe("ProgressBar", () => {
  const props = { label: "Juice Shop", done: 1, total: 38, unit: "patched", earned: 2, max: 141 };

  it("is a progressbar whose value and max are POINTS, with the count in its label", () => {
    const html = renderToStaticMarkup(<ProgressBar {...props} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('aria-valuemax="141"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-label="Juice Shop: 1 of 38 patched"');
  });

  it("gives a tiny score a minimum visible fill — 2/141 is a third of a pixel otherwise", () => {
    const html = renderToStaticMarkup(<ProgressBar {...props} />);
    expect(html).toContain(`min-width:${MIN_FILL_PX}px`);
  });

  it("gives nothing at all no fill — a floor at zero would read as progress", () => {
    const html = renderToStaticMarkup(<ProgressBar {...props} earned={0} done={0} />);
    expect(html).toContain("width:0%");
    expect(html).not.toContain(`min-width:${MIN_FILL_PX}px`);
  });

  it("never announces more than the ceiling, however the numbers arrive", () => {
    // A deleted or re-priced item leaves banked points above a shrunken
    // ceiling. The fill was already clamped; a screen reader hearing
    // "300 of 200" would have been told something the bar never showed.
    const html = renderToStaticMarkup(<ProgressBar {...props} earned={300} max={200} />);
    expect(html).toContain('aria-valuenow="200"');
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain("width:100%");
  });

  it("reports the count when the source has no points, never a 0 ceiling", () => {
    const html = renderToStaticMarkup(<ProgressBar {...props} earned={0} max={0} done={6} total={321} />);
    expect(html).toContain('aria-valuenow="6"');
    expect(html).toContain('aria-valuemax="321"');
  });
});
