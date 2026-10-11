// The Insights tab. renderToStaticMarkup only (no testing-library in this
// repo, by choice), so this pins the initial view — nothing behind the fetch
// ever appears in a static render — and drives the sparkline's time axis
// through the exported pure helper.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminInsightsTab, { axisLabels, bucketHeight, bucketTitle, bucketWidthLabel } from "@/app/(site)/admin/admin-insights-tab";

describe("AdminInsightsTab initial view", () => {
  it("offers the compute button, as primary, and says where the numbers come from", () => {
    const html = renderToStaticMarkup(<AdminInsightsTab visible live />);
    expect(html).toMatch(/<button[^>]*bg-\[#2563eb\][^>]*>Compute metrics/);
    expect(html).toMatch(/nothing is collected from contestants/i);
    expect(html).not.toContain("<table");
    // The stamp has nothing to say before a first load lands.
    expect(html).not.toContain("updated ");
  });
});

describe("axisLabels", () => {
  const bucket = (iso: string) => ({ at: iso });

  it("gives first, middle and last bucket as HH:MM inside one day", () => {
    const timeline = [
      bucket("2026-08-24T18:00:00.000Z"),
      bucket("2026-08-24T18:10:00.000Z"),
      bucket("2026-08-24T18:20:00.000Z"),
      bucket("2026-08-24T18:30:00.000Z"),
      bucket("2026-08-24T18:40:00.000Z"),
    ];
    expect(axisLabels(timeline)).toEqual({ start: "18:00", mid: "18:20", end: "18:40" });
  });

  it("prefixes the date once the buckets cross midnight, so the axis cannot read backwards", () => {
    const timeline = [bucket("2026-08-24T22:50:00.000Z"), bucket("2026-08-25T00:00:00.000Z"), bucket("2026-08-25T01:10:00.000Z")];
    expect(axisLabels(timeline)).toEqual({ start: "08-24 22:50", mid: "08-25 00:00", end: "08-25 01:10" });
  });

  it("picks the lower middle for an even count", () => {
    const timeline = [bucket("2026-08-24T18:00:00.000Z"), bucket("2026-08-24T18:10:00.000Z"), bucket("2026-08-24T18:20:00.000Z"), bucket("2026-08-24T18:30:00.000Z")];
    expect(axisLabels(timeline)?.mid).toBe("18:10");
  });

  it("is null for fewer than two buckets — one tick is not an axis", () => {
    expect(axisLabels([])).toBeNull();
    expect(axisLabels([bucket("2026-08-24T18:00:00.000Z")])).toBeNull();
  });
});

describe("the solves chart's buckets", () => {
  it("names the bucket's whole range and date in its tooltip", () => {
    expect(bucketTitle({ at: "2026-10-08T14:00:00.000Z", solves: 3 }, 30)).toBe("10-08 14:00–14:30 UTC · 3 solves");
    expect(bucketTitle({ at: "2026-10-08T23:00:00.000Z", solves: 1 }, 60)).toBe("10-08 23:00–00:00 UTC · 1 solve");
  });

  it("draws nothing for an empty bucket, so a quiet stretch reads as a gap", () => {
    expect(bucketHeight(0, 4)).toBe("0%");
    expect(bucketHeight(1, 4)).toBe("25%");
    expect(bucketHeight(4, 4)).toBe("100%");
  });

  it("keeps a single solve visible beside a tall peak", () => {
    expect(bucketHeight(1, 200)).toBe("6%");
  });

  it("names the bucket width the server chose", () => {
    expect(bucketWidthLabel(10)).toBe("Ten-minute");
    expect(bucketWidthLabel(30)).toBe("Thirty-minute");
    expect(bucketWidthLabel(60)).toBe("One-hour");
    expect(bucketWidthLabel(120)).toBe("Two-hour");
    expect(bucketWidthLabel(1440)).toBe("24-hour");
  });
});
