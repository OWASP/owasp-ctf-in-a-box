// ScoreTimeChart is a plain (server-renderable) function component with no
// "use client" — renderToStaticMarkup (ships with react-dom) is enough to
// check its output, same pattern as the admin page test.
// @testing-library/react is not a dependency of this repo and must not be
// added just for this test.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ScoreTimeChart, { scoreAt } from "@/components/score-time-chart";
import type { PlayerSeries } from "@/lib/leaderboard/types";

describe("scoreAt (hover readout)", () => {
  const raw = [
    { t: 100, score: 5 },
    { t: 200, score: 12 },
    { t: 300, score: 20 },
  ];
  it("is 0 before the first solve", () => {
    expect(scoreAt(raw, 50)).toBe(0);
  });
  it("holds the last solve's cumulative score between solves (step, not interpolated)", () => {
    expect(scoreAt(raw, 100)).toBe(5);
    expect(scoreAt(raw, 150)).toBe(5);
    expect(scoreAt(raw, 250)).toBe(12);
  });
  it("returns the final score at or after the last solve", () => {
    expect(scoreAt(raw, 300)).toBe(20);
    expect(scoreAt(raw, 999)).toBe(20);
  });
});

function series(overrides: Partial<Record<string, PlayerSeries["points"]>> = {}): PlayerSeries[] {
  const base: Record<string, PlayerSeries["points"]> = {
    alice: [
      { t: "2026-08-01T00:00:00.000Z", score: 10 },
      { t: "2026-08-01T04:00:00.000Z", score: 40 },
      { t: "2026-08-01T08:00:00.000Z", score: 90 },
    ],
    bob: [
      { t: "2026-08-01T01:00:00.000Z", score: 20 },
      { t: "2026-08-01T06:00:00.000Z", score: 60 },
    ],
    carol: [
      { t: "2026-08-01T02:00:00.000Z", score: 5 },
      { t: "2026-08-01T07:00:00.000Z", score: 30 },
      { t: "2026-08-01T08:00:00.000Z", score: 50 },
    ],
    ...overrides,
  };
  return Object.entries(base).map(([login, points]) => ({ login, points }));
}

function countOccurrences(html: string, substring: string): number {
  return html.split(substring).length - 1;
}

describe("ScoreTimeChart", () => {
  it("renders an svg with one line path and one legend entry per player", () => {
    const html = renderToStaticMarkup(<ScoreTimeChart series={series()} />);
    expect(html).toContain("<svg");
    // One <path> per player with >=2 points (all three here).
    expect(countOccurrences(html, "<path")).toBe(3);
    // Legend: one entry per login.
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("carol");
  });

  // #547: the time axis reads on the event's clock (UTC by default).
  it("labels the time axis in the event's zone", () => {
    const utc = renderToStaticMarkup(<ScoreTimeChart series={series()} />);
    expect(utc).not.toContain("Jul 31");
    const ba = renderToStaticMarkup(<ScoreTimeChart series={series()} timeZone="America/Argentina/Buenos_Aires" />);
    expect(ba).toContain("Jul 31");
  });

  it("renders nothing for undefined series", () => {
    const html = renderToStaticMarkup(<ScoreTimeChart series={undefined} />);
    expect(html).toBe("");
  });

  it("renders nothing for an empty series array", () => {
    const html = renderToStaticMarkup(<ScoreTimeChart series={[]} />);
    expect(html).toBe("");
  });

  it("renders nothing when every player has zero points", () => {
    const html = renderToStaticMarkup(<ScoreTimeChart series={[{ login: "alice", points: [] }]} />);
    expect(html).toBe("");
  });

  it("draws a full step line even for a single-point series", () => {
    const withSinglePoint = series({
      dave: [{ t: "2026-08-01T05:00:00.000Z", score: 15 }],
    });
    const html = renderToStaticMarkup(<ScoreTimeChart series={withSinglePoint} />);
    expect(html).toContain("<svg");
    // Every series gets a step path now — anchored at zero on the left edge
    // and held flat to the right — so dave's lone solve is a line, not a
    // floating marker. Four players, four paths.
    expect(countOccurrences(html, "<path")).toBe(4);
    expect(html).toContain("dave");
  });

  it("shows a note instead of a broken axis when every point shares one instant", () => {
    const html = renderToStaticMarkup(
      <ScoreTimeChart
        series={[
          { login: "alice", points: [{ t: "2026-08-01T00:00:00.000Z", score: 10 }] },
          { login: "bob", points: [{ t: "2026-08-01T00:00:00.000Z", score: 20 }] },
        ]}
      />,
    );
    expect(html).not.toContain("<svg");
    expect(html.toLowerCase()).toMatch(/not enough|no history/);
  });

  it("folds players past the 8-color ceiling into a shared 'Other' legend entry, never a generated hue", () => {
    const many: PlayerSeries[] = Array.from({ length: 10 }, (_, i) => ({
      login: `player${i}`,
      points: [
        { t: "2026-08-01T00:00:00.000Z", score: 10 + i },
        { t: "2026-08-01T04:00:00.000Z", score: 100 - i },
      ],
    }));
    const html = renderToStaticMarkup(<ScoreTimeChart series={many} />);
    expect(countOccurrences(html, "<path")).toBe(10);
    expect(html).toContain("+2 more");
  });

  it("renders per-team lines when given teamSeries instead of a player series", () => {
    const teamSeries = [
      {
        slug: "red-team",
        name: "Red Team",
        points: [
          { t: "2026-08-01T00:00:00.000Z", score: 10 },
          { t: "2026-08-01T04:00:00.000Z", score: 80 },
        ],
      },
      {
        slug: "blue-team",
        name: "Blue Team",
        points: [
          { t: "2026-08-01T01:00:00.000Z", score: 20 },
          { t: "2026-08-01T05:00:00.000Z", score: 60 },
        ],
      },
    ];
    const html = renderToStaticMarkup(<ScoreTimeChart teamSeries={teamSeries} />);
    expect(html).toContain("<svg");
    expect(countOccurrences(html, "<path")).toBe(2);
    expect(html).toContain("Red Team");
    expect(html).toContain("Blue Team");
  });

  it("ignores a player series when teamSeries is also provided (teamSeries wins)", () => {
    const html = renderToStaticMarkup(
      <ScoreTimeChart
        series={series()}
        teamSeries={[
          {
            slug: "red-team",
            name: "Red Team",
            points: [
              { t: "2026-08-01T00:00:00.000Z", score: 10 },
              { t: "2026-08-01T04:00:00.000Z", score: 80 },
            ],
          },
          {
            slug: "blue-team",
            name: "Blue Team",
            points: [
              { t: "2026-08-01T01:00:00.000Z", score: 20 },
              { t: "2026-08-01T05:00:00.000Z", score: 60 },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Red Team");
    expect(html).toContain("Blue Team");
    expect(html).not.toContain("alice");
  });

  it("renders nothing for an empty teamSeries array", () => {
    const html = renderToStaticMarkup(<ScoreTimeChart teamSeries={[]} />);
    expect(html).toBe("");
  });
});
