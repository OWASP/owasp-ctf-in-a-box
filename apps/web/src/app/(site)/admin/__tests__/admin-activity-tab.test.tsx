// The Activity tab (issue #212). renderToStaticMarkup only (no
// testing-library in this repo, by choice), so these assert the initial
// server-derived view — anything behind the load button never appears in a
// static render — and drive the filter/format logic through the exported
// helpers directly.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import AdminActivityTab, {
  filterEntries,
  formatWhen,
  mergeRefresh,
  refreshLimit,
  type ActivityEntry,
} from "@/app/(site)/admin/admin-activity-tab";

describe("AdminActivityTab initial view", () => {
  it("offers the load button and says what the log holds, with no table yet", () => {
    const html = renderToStaticMarkup(<AdminActivityTab />);
    expect(html).toContain("Load activity");
    expect(html).toMatch(/never a flag or an answer/i);
    expect(html).not.toContain("<table");
  });

  it("shows the load button as primary while nothing is loaded — the poll has not run yet", () => {
    const html = renderToStaticMarkup(<AdminActivityTab visible live />);
    expect(html).toMatch(/<button[^>]*bg-\[#2563eb\][^>]*>Load activity/);
    // The stamp has nothing to say before a first load lands.
    expect(html).not.toContain("updated ");
  });
});

// A timed refresh re-reads from the top; this decides how far down. Dropping
// rows the organizer had paged in would make the log jump under them every
// 15 seconds.
describe("refreshLimit", () => {
  it("re-reads at least a page", () => {
    expect(refreshLimit(0)).toBe(200);
    expect(refreshLimit(37)).toBe(200);
  });

  it("keeps everything already paged in", () => {
    expect(refreshLimit(400)).toBe(400);
  });

  it("stops at the route's cap", () => {
    expect(refreshLimit(900)).toBe(500);
  });
});

// Past the route's cap a refresh cannot re-read everything in one request,
// so the rows the fresh page did not reach are kept rather than dropped.
describe("mergeRefresh", () => {
  const row = (i: number): ActivityEntry => ({
    at: `2026-08-24T18:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
    type: "login",
    login: `u${i}`,
  });
  const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => row(from + k));

  it("keeps rows paged in beyond what the fresh page covers", () => {
    const prev = rows(0, 600);
    const fresh = rows(0, 500);
    const merged = mergeRefresh(fresh, prev, 600);
    expect(merged).toHaveLength(600);
    expect(merged.slice(500)).toEqual(prev.slice(500));
  });

  it("does not duplicate a row the fresh page already holds after new events shift everything down", () => {
    const prev = rows(0, 600);
    // One new event at the top: the fresh 500 are new + the old 0..498.
    const fresh = [{ at: "2026-08-24T19:00:00.000Z", type: "login", login: "new" }, ...rows(0, 499)];
    const merged = mergeRefresh(fresh, prev, 601);
    expect(merged).toHaveLength(601);
    expect(new Set(merged.map((e) => e.login)).size).toBe(601);
  });

  it("keeps the row a new event pushed out of a same-sized page — same length is not 'nothing to keep'", () => {
    // Exactly the cap loaded, one new event since: the fresh 500 are new +
    // old 0..498, and old 499 would otherwise vanish from the screen.
    const prev = rows(0, 500);
    const fresh = [{ at: "2026-08-24T19:00:00.000Z", type: "login", login: "new" }, ...rows(0, 499)];
    const merged = mergeRefresh(fresh, prev, 501);
    expect(merged).toHaveLength(501);
    expect(merged[500]).toEqual(row(499));
  });

  it("replaces everything when the fresh page covers the loaded rows", () => {
    expect(mergeRefresh(rows(0, 20), rows(0, 19), 20)).toEqual(rows(0, 20));
    expect(mergeRefresh(rows(0, 5), null, 5)).toEqual(rows(0, 5));
  });

  it("replaces everything when the server says the whole log fits the page — a reset is not padded with ghosts", () => {
    expect(mergeRefresh([], rows(0, 600), 0)).toEqual([]);
    expect(mergeRefresh(rows(0, 3), rows(0, 600), 3)).toEqual(rows(0, 3));
  });
});

describe("formatWhen", () => {
  it("renders on the event's clock, to the second, with the offset named", () => {
    expect(formatWhen("2026-08-24T18:03:27.000Z", "UTC")).toBe("08-24 18:03:27 UTC");
    expect(formatWhen("2026-08-24T18:03:27.000Z", "America/Argentina/Buenos_Aires")).toBe("08-24 15:03:27 GMT-3");
  });
});

describe("filterEntries", () => {
  const entries: ActivityEntry[] = [
    { at: "2026-08-24T18:00:00.000Z", type: "login", login: "octocat" },
    { at: "2026-08-24T18:01:00.000Z", type: "classic-solve", login: "OctoCat", detail: "crypto-1" },
    { at: "2026-08-24T18:02:00.000Z", type: "login", login: "hubot" },
  ];

  it("passes everything through with no filters", () => {
    expect(filterEntries(entries, null, "")).toEqual(entries);
  });

  it("filters by type", () => {
    expect(filterEntries(entries, "login", "").map((e) => e.login)).toEqual(["octocat", "hubot"]);
  });

  it("matches login as a case-insensitive substring", () => {
    expect(filterEntries(entries, null, "OCTO")).toHaveLength(2);
    expect(filterEntries(entries, null, "  hub ").map((e) => e.login)).toEqual(["hubot"]);
  });

  it("applies both filters together", () => {
    expect(filterEntries(entries, "classic-solve", "octo")).toEqual([entries[1]]);
  });
});
