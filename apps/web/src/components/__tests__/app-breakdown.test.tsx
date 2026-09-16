// AppBreakdown renders the per-target progress inside a profile or an
// expanded leaderboard row. Until issue #200 (2.4) it rendered every target
// carrying a challenge catalogue TWICE back to back — a stats-grid card, then
// a second card repeating the name and patched count verbatim to host the
// collapsible challenge list — so these tests pin the merged single-card
// shape by counting name occurrences, not just checking presence.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AppBreakdown from "@/components/app-breakdown";
import { apps, appsById } from "@/lib/apps";
import type { ChallengeCatalog, LeaderboardEntry } from "@/lib/leaderboard/types";

// The catalogue the rows join against (issue #434): names live here once,
// rows carry only the ids they solved.
const catalog: ChallengeCatalog = {
  dvwa: [
    { key: "sqli-low", name: "SQL Injection (Low)", points: 10, owasp: "A05" },
    { key: "xss-low", name: "XSS (Low)", points: 20, owasp: "A05" },
  ],
};

function entry(overrides: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    rank: 1,
    login: "ada",
    team: null,
    points: 100,
    patched: 3,
    failed: 0,
    total: 3,
    apps: {},
    updatedAt: null,
    ...overrides,
  };
}

// Counts the target's VISIBLE name only. The bar's aria-label carries the
// name too ("DVWA: 1 of 2 patched"), which a raw substring count reads as a
// second card — the duplication this file exists to catch is two rendered
// labels, not a label plus its accessible name.
const count = (html: string, needle: string) => html.split(`>${needle}<`).length - 1;

describe("AppBreakdown", () => {
  it("renders a target with a challenge list ONCE — stats and list in one card", () => {
    const html = renderToStaticMarkup(
      <AppBreakdown
        showPoints
        enabledApps={apps}
        entry={entry({
          apps: {
            dvwa: {
              app: "dvwa",
              points: 30,
              maxPoints: 60,
              patched: 1,
              total: 2,
              solvedIds: ["sqli-low"],
            },
          },
        })}
        catalog={catalog}
      />,
    );
    // The duplication this replaces rendered the name in the grid AND above
    // the list — exactly the regression a bare `toContain` cannot catch.
    expect(count(html, "DVWA")).toBe(1);
    expect(html).toContain("/ 2 patched");
    // The stats moved INTO the list card rather than being dropped.
    expect(html).toContain("/ 60 pts");
    // The target row IS the disclosure now — no separate "Show N challenges"
    // toggle nested inside it.
    expect(html).toContain("<details");
    expect(html).toContain("SQL Injection (Low)");
  });

  it("keeps the compact grid for targets without a catalogue", () => {
    const html = renderToStaticMarkup(
      <AppBreakdown
        enabledApps={apps}
        entry={entry({
          apps: { dvwa: { app: "dvwa", points: 0, maxPoints: 0, patched: 1, total: 2 } },
        })}
      />,
    );
    expect(count(html, "DVWA")).toBe(1);
    expect(html).not.toContain("Show ");
  });

  it("narrows to enabledApps: a target the entry scored but the event since disabled renders nothing", () => {
    // entry.apps names dvwa only; enabledApps carries just vampi (an
    // organizer switched dvwa off after this row was scored). The doc
    // comment on `attempted` says a stale scored row must not surface a
    // disabled target — this pins that filter, not just its presence.
    const html = renderToStaticMarkup(
      <AppBreakdown
        enabledApps={[appsById.vampi]}
        entry={entry({
          apps: { dvwa: { app: "dvwa", points: 0, maxPoints: 0, patched: 1, total: 2 } },
        })}
      />,
    );
    expect(html).toContain("No app breakdown reported yet.");
    expect(html).not.toContain("DVWA");
  });
});

describe("AppBreakdown — catalogue join (issue #434)", () => {
  it("names a solved challenge Patched and an unsolved one Open, from ids + catalogue", () => {
    const html = renderToStaticMarkup(
      <AppBreakdown
        showPoints
        enabledApps={apps}
        catalog={catalog}
        entry={entry({ apps: { dvwa: { app: "dvwa", points: 10, maxPoints: 30, patched: 1, total: 2, solvedIds: ["sqli-low"] } } })}
      />,
    );
    expect(html).toContain("SQL Injection (Low)");
    expect(html).toContain("XSS (Low)");
    expect(html).toContain("Patched");
    expect(html).toContain("Open");
  });

  it("renders the target row without a list when no catalogue was supplied", () => {
    const html = renderToStaticMarkup(
      <AppBreakdown
        enabledApps={apps}
        entry={entry({ apps: { dvwa: { app: "dvwa", points: 0, maxPoints: 0, patched: 1, total: 2, solvedIds: ["sqli-low"] } } })}
      />,
    );
    expect(html).toContain(appsById.dvwa.name);
    expect(html).not.toContain("SQL Injection (Low)");
  });

  // An id the catalogue no longer has (a challenge removed from the rubric
  // after it was solved) must not render as a nameless row or throw.
  it("ignores a solved id that is no longer in the catalogue", () => {
    const html = renderToStaticMarkup(
      <AppBreakdown
        enabledApps={apps}
        catalog={catalog}
        entry={entry({ apps: { dvwa: { app: "dvwa", points: 10, maxPoints: 30, patched: 1, total: 2, solvedIds: ["sqli-low", "gone"] } } })}
      />,
    );
    expect(html).not.toContain("gone");
    expect(html).toContain("SQL Injection (Low)");
  });
});
