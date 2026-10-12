// The one answer to "may a contestant see this Jeopardy challenge right now?"
// Pure, so every reader (board, detail page, board items, profile, the
// leaderboard denominators, the admin chip) asks the same function and none
// can drift onto a rule of its own.
import { describe, expect, it } from "vitest";
import { challengeStatus, isChallengeVisible, visibleChallenges } from "@/lib/classic-release";

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
