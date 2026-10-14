// The one answer to "may a contestant see this Jeopardy challenge right now?"
// Pure, so every reader (board, detail page, board items, profile, the
// leaderboard denominators, the admin chip) asks the same function and none
// can drift onto a rule of its own.
import { describe, expect, it } from "vitest";
import { challengeStatus, isChallengeVisible, isReleaseInstant, visibleChallenges } from "@/lib/classic-release";

const NOW = Date.UTC(2026, 9, 8, 13, 0, 0);

describe("isChallengeVisible", () => {
  it("treats an absent `enabled` as live, so every record written before the field stays on the board", () => {
    expect(isChallengeVisible({}, NOW)).toBe(true);
  });

  it("shows an enabled challenge and hides a disabled one", () => {
    expect(isChallengeVisible({ enabled: true }, NOW)).toBe(true);
    expect(isChallengeVisible({ enabled: false }, NOW)).toBe(false);
  });
});

describe("visibleChallenges", () => {
  it("keeps the visible records, in their order, and drops the hidden ones", () => {
    const list = [{ id: "a" }, { id: "b", enabled: false }, { id: "c", enabled: true }];
    expect(visibleChallenges(list, NOW).map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("isChallengeVisible with a release time", () => {
  const at = new Date(NOW).toISOString();

  it("hides a disabled challenge until its release instant, and shows it from that instant on", () => {
    const c = { enabled: false, releaseAt: at };
    expect(isChallengeVisible(c, NOW - 1)).toBe(false);
    // The boundary instant itself is released (now >= releaseAt).
    expect(isChallengeVisible(c, NOW)).toBe(true);
    expect(isChallengeVisible(c, NOW + 1)).toBe(true);
  });

  it("keeps a disabled challenge with no release time hidden at any time", () => {
    expect(isChallengeVisible({ enabled: false, releaseAt: null }, NOW + 1e12)).toBe(false);
  });

  it("treats an unreadable release time as no release time", () => {
    expect(isChallengeVisible({ enabled: false, releaseAt: "not a date" }, NOW + 1e12)).toBe(false);
  });

  it("shows an enabled challenge whatever its release time says", () => {
    expect(isChallengeVisible({ enabled: true, releaseAt: new Date(NOW + 60_000).toISOString() }, NOW)).toBe(true);
  });
});

describe("challengeStatus", () => {
  it("names a disabled challenge with a future release Scheduled, carrying the instant, and Live once it has passed", () => {
    const releaseAt = new Date(NOW + 60_000).toISOString();
    expect(challengeStatus({ enabled: false, releaseAt }, NOW)).toEqual({ kind: "scheduled", releaseAt });
    expect(challengeStatus({ enabled: false, releaseAt }, NOW + 60_000)).toEqual({ kind: "live" });
  });

  it("names a live challenge Live and a disabled one Disabled", () => {
    expect(challengeStatus({}, NOW)).toEqual({ kind: "live" });
    expect(challengeStatus({ enabled: false }, NOW)).toEqual({ kind: "disabled" });
  });
});

// A release time is an instant, so it must say which zone it is in: an
// offset-less "2026-10-08T10:00:00" would be read in the SERVER's zone and
// release at the wrong moment.
describe("isReleaseInstant", () => {
  it("accepts an ISO 8601 date-time ending in Z or an explicit offset", () => {
    for (const ok of ["2026-10-08T13:00:00.000Z", "2026-10-08T13:00:00Z", "2026-10-08T13:00Z", "2026-10-08T10:00:00-03:00", "2026-10-08T15:00:00.5+02:00", "2028-02-29T00:00:00Z"]) {
      expect(isReleaseInstant(ok), ok).toBe(true);
    }
  });

  it("refuses one without a zone, and anything that is not a date-time", () => {
    for (const bad of ["2026-10-08T10:00:00", "2026-10-08T10:00", "2026-10-08", "Oct 8 2026 10:00 GMT", "2026-10-08 10:00:00Z", "", "tomorrow"]) {
      expect(isReleaseInstant(bad), bad).toBe(false);
    }
  });

  it("refuses a date or time that does not exist, which Date would roll over", () => {
    for (const bad of ["2026-02-30T10:00:00Z", "2026-02-29T10:00:00Z", "2026-13-01T10:00:00Z", "2026-04-31T10:00:00Z", "2026-10-08T25:00:00Z", "2026-10-08T23:60:00Z", "2026-10-08T23:00:60Z", "2026-10-08T10:00:00+24:00", "2026-10-08T10:00:00+05:60"]) {
      expect(isReleaseInstant(bad), bad).toBe(false);
    }
  });

  it("accepts what the admin editor produces from an event-clock wall time", async () => {
    const { wallToInstant } = await import("@/lib/event-time");
    expect(isReleaseInstant(wallToInstant("2026-10-08T10:00", "America/Argentina/Buenos_Aires")!)).toBe(true);
    expect(isReleaseInstant(wallToInstant("2026-03-29T02:30", "Europe/Madrid")!)).toBe(true);
  });
});
