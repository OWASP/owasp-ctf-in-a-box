// The Activity tab (issue #212). renderToStaticMarkup only (no
// testing-library in this repo, by choice), so these assert the initial
// server-derived view — anything behind the load button never appears in a
// static render — and drive the filter/format logic through the exported
// helpers directly.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import AdminActivityTab, {
  filterEntries,
  rangeSince,
  searchFromUrl,
  typeCounts,
  urlWithSearch,
  formatWhen,
  mergeRefresh,
  refreshLimit,
  type ActivityEntry,
} from "@/app/(site)/admin/admin-activity-tab";

describe("AdminActivityTab initial view", () => {
  it("offers a Show UTC switch beside the toolbar, off by default", () => {
    const html = renderToStaticMarkup(<AdminActivityTab />);
    expect(html).toContain("Show UTC");
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  });

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

// #609. The box matched the login only, so "who solved crypto-1", "every
// team-join" or "what happened at 16:5x" could not be asked; you scrolled.
describe("filterEntries", () => {
  const entries: ActivityEntry[] = [
    { at: "2026-08-24T18:00:00.000Z", type: "login", login: "octocat" },
    { at: "2026-08-24T18:01:00.000Z", type: "classic-solve", login: "OctoCat", detail: "crypto-1" },
    { at: "2026-08-24T18:02:00.000Z", type: "login", login: "hubot" },
    { at: "2026-08-24T18:40:00.000Z", type: "team-join", login: "hubot", detail: "octo-team" },
  ];
  const q = (text: string, extra: Partial<Parameters<typeof filterEntries>[1]> = {}) =>
    filterEntries(entries, { type: null, text, zone: "UTC", ...extra });

  it("passes everything through with no filters", () => {
    expect(q("")).toEqual(entries);
  });

  it("filters by type", () => {
    expect(q("", { type: "login" }).map((e) => e.login)).toEqual(["octocat", "hubot"]);
  });

  it("matches login as a case-insensitive substring", () => {
    expect(q("  hubot ").map((e) => e.type)).toEqual(["login", "team-join"]);
  });

  it("finds a row by its detail alone", () => {
    expect(q("crypto")).toEqual([entries[1]]);
  });

  it("finds a type by its label or its id", () => {
    expect(q("joined")).toEqual([entries[3]]);
    expect(q("team-join")).toEqual([entries[3]]);
  });

  it("finds a row by its time as displayed, on the panel's clock", () => {
    expect(q("18:4")).toEqual([entries[3]]);
    // 18:40 UTC is 15:40 in Buenos Aires; the panel shows, and so matches, 15:40.
    expect(q("15:4", { zone: "America/Argentina/Buenos_Aires" })).toEqual([entries[3]]);
    expect(q("18:4", { zone: "America/Argentina/Buenos_Aires" })).toEqual([]);
  });

  it("needs every word to match somewhere in the row", () => {
    expect(q("octo solve")).toEqual([entries[1]]);
    expect(q("hubot crypto")).toEqual([]);
  });

  it("restricts a prefixed word to that field", () => {
    // "octo" is in octocat's login AND in hubot's team slug.
    expect(q("octo").map((e) => e.login)).toEqual(["octocat", "OctoCat", "hubot"]);
    expect(q("login:octo").map((e) => e.login)).toEqual(["octocat", "OctoCat"]);
    expect(q("detail:octo")).toEqual([entries[3]]);
    expect(q("type:solve")).toEqual([entries[1]]);
  });

  it("matches team: on team events only", () => {
    expect(q("team:octo")).toEqual([entries[3]]);
    expect(q("team:crypto")).toEqual([]);
  });

  it("ignores a prefix with nothing after it", () => {
    expect(q("login:")).toEqual(entries);
  });

  it("keeps only rows inside the time range", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(q("", { since: at("2026-08-24T18:01:00Z") })).toEqual(entries.slice(1));
    expect(q("", { since: at("2026-08-24T18:01:00Z"), until: at("2026-08-24T18:02:00Z") })).toEqual(entries.slice(1, 3));
  });

  it("applies the type, the words and the range together", () => {
    expect(q("octo", { type: "classic-solve", since: Date.parse("2026-08-24T18:00:30Z") })).toEqual([entries[1]]);
  });
});

describe("typeCounts", () => {
  it("counts each type within the current search, ignoring the type chip", () => {
    const entries: ActivityEntry[] = [
      { at: "2026-08-24T18:00:00.000Z", type: "login", login: "octocat" },
      { at: "2026-08-24T18:01:00.000Z", type: "classic-solve", login: "octocat", detail: "crypto-1" },
      { at: "2026-08-24T18:02:00.000Z", type: "login", login: "hubot" },
    ];
    expect(typeCounts(entries, { type: "login", text: "octocat", zone: "UTC" })).toEqual({ login: 1, "classic-solve": 1 });
  });
});

describe("rangeSince", () => {
  const now = Date.parse("2026-08-24T18:00:00Z");
  it("turns a quick pick into a lower bound, and 'all' into none", () => {
    expect(rangeSince("all", now)).toBeNull();
    expect(rangeSince("15m", now)).toBe(now - 15 * 60_000);
    expect(rangeSince("1h", now)).toBe(now - 3_600_000);
    expect(rangeSince("6h", now)).toBe(now - 6 * 3_600_000);
    expect(rangeSince("24h", now)).toBe(now - 24 * 3_600_000);
  });
});

// A filtered view survives a refresh and can be handed to another organizer.
describe("the search in the URL", () => {
  it("reads ?q= back", () => {
    expect(searchFromUrl("?tab=activity&q=octo+solve")).toBe("octo solve");
    expect(searchFromUrl("?tab=activity")).toBe("");
  });

  it("writes ?q= beside the tab, and drops it when the box is cleared", () => {
    expect(urlWithSearch("/admin?tab=activity", "login:octo")).toBe("/admin?tab=activity&q=login%3Aocto");
    expect(urlWithSearch("/admin?tab=activity&q=old", "  ")).toBe("/admin?tab=activity");
  });
});
