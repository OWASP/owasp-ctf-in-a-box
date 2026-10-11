// The activity times read on the event's clock by default, with a per-browser
// "Show UTC" switch for matching a row against server logs. Static renders
// only: the switch's first paint is the event zone on server and client
// alike, and the stored preference applies after mount.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));

import { activityZone, UtcToggle } from "../activity-time-zone";

describe("activityZone", () => {
  it("reads on the event's clock unless UTC is asked for", () => {
    expect(activityZone("America/Argentina/Buenos_Aires", false)).toBe("America/Argentina/Buenos_Aires");
    expect(activityZone("America/Argentina/Buenos_Aires", true)).toBe("UTC");
  });
});

describe("UtcToggle", () => {
  it("is a real, labelled checkbox, unchecked on first paint", () => {
    const html = renderToStaticMarkup(<UtcToggle checked={false} onChange={() => {}} />);
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain("Show UTC");
    expect(html).toMatch(/<label/);
  });

  it("shows as checked when UTC is on", () => {
    const html = renderToStaticMarkup(<UtcToggle checked onChange={() => {}} />);
    expect(html).toMatch(/<input[^>]*checked/);
  });
});
