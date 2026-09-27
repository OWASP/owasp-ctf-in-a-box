// nextScheduleBoundary feeds the /admin shell's re-stamp timer: the Event
// tab's "Right now" readout is computed against a stamped `nowMs` (not a
// render-time clock read, which the compiler lint rejects), so something has
// to re-stamp it when a scheduled window opens or closes while the page sits
// open. These pin the instant it hands back — the exact tick at which
// outsideWindow flips — so the readout can never be stale for longer than a
// timer's imprecision.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextScheduleBoundary, outsideScoringWindow, outsideWindow } from "@/lib/schedule-window";

// Shared differential corpus (issue #232): the same cases run verbatim in
// scorer/test/store.test.js and sync/test/redis.test.js against their own
// outsideWindow copy, so a <-><= flip surviving one reader's hand-written
// tests still fails here (or vice versa) instead of drifting silently.
const CORPUS_PATH = fileURLToPath(new URL("../../../../../test/fixtures/window-corpus.json", import.meta.url));
const { cases: windowCorpus } = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
  cases: { description: string; nowMs: number; startsAt: string | null; endsAt: string | null; expected: boolean }[];
};

describe("outsideWindow: shared boundary-instant corpus", () => {
  for (const { description, nowMs, startsAt, endsAt, expected } of windowCorpus) {
    it(description, () => {
      expect(outsideWindow(nowMs, startsAt, endsAt)).toBe(expected);
    });
  }
});

// The scoring window's own corpus (#464): same differential idea, but a start
// is REQUIRED — an absent or unparseable scoringStartsAt means the event has
// not launched. Runs verbatim in scorer/test/store.test.js and
// sync/test/redis.test.js too.
const SCORING_CORPUS_PATH = fileURLToPath(
  new URL("../../../../../test/fixtures/scoring-window-corpus.json", import.meta.url),
);
const { cases: scoringCorpus } = JSON.parse(readFileSync(SCORING_CORPUS_PATH, "utf8")) as {
  cases: { description: string; nowMs: number; startsAt: string | null; endsAt: string | null; expected: boolean }[];
};

describe("outsideScoringWindow: shared scoring-window corpus (#464)", () => {
  for (const { description, nowMs, startsAt, endsAt, expected } of scoringCorpus) {
    it(description, () => {
      expect(outsideScoringWindow(nowMs, startsAt, endsAt)).toBe(expected);
    });
  }
});

const T = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const w = (startsAt: string | null, endsAt: string | null) => ({ startsAt, endsAt });

describe("nextScheduleBoundary", () => {
  it("returns the earliest instant after now at which any window flips", () => {
    const windows = [w(iso(T + 60_000), iso(T + 3_600_000)), w(null, iso(T + 30_000))];
    // The end bound flips one ms AFTER the bound (outsideWindow is `now > e`).
    expect(nextScheduleBoundary(T, windows)).toBe(T + 30_000 + 1);
  });

  it("skips bounds already passed and a start bound equal to now", () => {
    expect(nextScheduleBoundary(T, [w(iso(T - 1), null), w(iso(T), iso(T + 5_000))])).toBe(T + 5_000 + 1);
  });

  it("returns null when nothing lies ahead, nothing is set, or a bound is unparseable", () => {
    expect(nextScheduleBoundary(T, [w(null, null)])).toBeNull();
    expect(nextScheduleBoundary(T, [])).toBeNull();
    expect(nextScheduleBoundary(T, [w(iso(T - 10), "not a date")])).toBeNull();
  });

  it("crossing a start boundary flips outsideWindow from true to false", () => {
    const startsAt = iso(T + 60_000);
    expect(outsideWindow(T, startsAt, null)).toBe(true);
    const at = nextScheduleBoundary(T, [w(startsAt, null)]);
    expect(at).toBe(T + 60_000);
    expect(outsideWindow(at!, startsAt, null)).toBe(false);
    // Nothing further to wait for once the window is open.
    expect(nextScheduleBoundary(at!, [w(startsAt, null)])).toBeNull();
  });

  it("crossing an end boundary flips outsideWindow from false to true", () => {
    const endsAt = iso(T + 60_000);
    expect(outsideWindow(T, null, endsAt)).toBe(false);
    const at = nextScheduleBoundary(T, [w(null, endsAt)]);
    expect(at).toBe(T + 60_000 + 1);
    expect(outsideWindow(at!, null, endsAt)).toBe(true);
  });
});
