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
import {
  launchState,
  nextScheduleBoundary,
  outsideScoringWindow,
  outsideWindow,
  restampPlan,
  scoringClosure,
  serverFloorNow,
} from "@/lib/schedule-window";

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

// #567: the ONE place that says WHY scoring is closed. `effectivePaused`
// folds the manual freeze and the schedule into a boolean, which is right for
// the scorer/sync readers but leaves the contestant-facing copy unable to
// tell a pause ("try again later") from the end of the event (final). An END
// that has passed wins over everything else: a freeze toggled on after the
// close is still the end of the event.
describe("scoringClosure (#567)", () => {
  it("is null while scoring is live", () => {
    expect(scoringClosure(T, false, iso(T - 60_000), null)).toBeNull();
    expect(scoringClosure(T, false, iso(T - 60_000), iso(T + 60_000))).toBeNull();
  });

  it("is 'paused' for the manual freeze", () => {
    expect(scoringClosure(T, true, iso(T - 60_000), null)).toBe("paused");
  });

  it("is 'paused' before launch and before a scheduled start — not 'ended'", () => {
    expect(scoringClosure(T, false, null, null)).toBe("paused");
    expect(scoringClosure(T, false, iso(T + 60_000), null)).toBe("paused");
  });

  it("is 'ended' once the scheduled end has passed, even when the freeze is also on", () => {
    expect(scoringClosure(T, false, iso(T - 7_200_000), iso(T - 60_000))).toBe("ended");
    expect(scoringClosure(T, true, iso(T - 7_200_000), iso(T - 60_000))).toBe("ended");
  });

  it("flips to 'ended' one ms after the end, matching outsideWindow's `now > e`", () => {
    const end = T + 60_000;
    expect(scoringClosure(end, false, iso(T), iso(end))).toBeNull();
    expect(scoringClosure(end + 1, false, iso(T), iso(end))).toBe("ended");
  });

  it("ignores an unparseable end, like outsideWindow does", () => {
    expect(scoringClosure(T, false, iso(T - 60_000), "not a date")).toBeNull();
  });
});

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

describe("launchState (#464, the /admin Launch block)", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  it("is not-launched with no, an empty, or an unparseable start", () => {
    expect(launchState(now, null)).toEqual({ kind: "not-launched" });
    expect(launchState(now, "")).toEqual({ kind: "not-launched" });
    expect(launchState(now, "nope")).toEqual({ kind: "not-launched" });
  });
  it("is scheduled while the start is ahead, and live from it on", () => {
    expect(launchState(now, "2026-10-02T00:00:00Z")).toEqual({ kind: "scheduled", at: "2026-10-02T00:00:00.000Z" });
    expect(launchState(now, "2026-10-01T12:00:00Z")).toEqual({ kind: "live", since: "2026-10-01T12:00:00.000Z" });
  });
});

describe("serverFloorNow (#464, the /admin readouts' now)", () => {
  it("floors the client stamp at the last server instant, and ignores a missing or bad one", () => {
    expect(serverFloorNow(1000, new Date(5000).toISOString())).toBe(5000);
    expect(serverFloorNow(9000, new Date(5000).toISOString())).toBe(9000);
    expect(serverFloorNow(1000, null)).toBe(1000);
    expect(serverFloorNow(1000, "nope")).toBe(1000);
  });
});

// CodeRabbit #469: with the client clock behind the server floor, a timer that
// re-stamped Date.now() fell back under the floor and re-armed the SAME
// boundary forever; and a stamp on the floored timeline must carry its own
// client-clock anchor, or the next delay mixes the two clocks.
describe("restampPlan (#464, the /admin boundary timer)", () => {
  const floor = Date.parse("2026-10-01T12:00:00Z");
  const updatedAt = new Date(floor).toISOString();
  const start = floor + 60_000;
  const end = start + 60_000;
  const clientStamp = floor - 5 * 60_000; // client 5 minutes behind the server
  const windows = [{ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }];

  it("waits until the boundary on the floored timeline, then stamps the boundary itself", () => {
    const plan = restampPlan({ at: clientStamp, client: clientStamp }, updatedAt, windows, clientStamp);
    expect(plan).toEqual({ delayMs: 60_000, stampAt: start });
    expect(launchState(serverFloorNow(plan!.stampAt, updatedAt), new Date(start).toISOString()).kind).toBe("live");
  });

  it("measures the NEXT boundary from the stamp's own client anchor — no skew added", () => {
    // Fired one real minute after the first stamp: stamp = the start, anchored
    // at the client time it fired.
    const fired = { at: start, client: clientStamp + 60_000 };
    const plan = restampPlan(fired, updatedAt, windows, clientStamp + 60_000);
    expect(plan).toEqual({ delayMs: 60_001, stampAt: end + 1 });
  });

  it("counts time already elapsed since the stamp", () => {
    const plan = restampPlan({ at: clientStamp, client: clientStamp }, updatedAt, windows, clientStamp + 20_000);
    expect(plan?.delayMs).toBe(40_000);
  });

  it("is null once no bound lies ahead", () => {
    expect(restampPlan({ at: end + 1, client: 0 }, updatedAt, windows, 0)).toBeNull();
  });
});
