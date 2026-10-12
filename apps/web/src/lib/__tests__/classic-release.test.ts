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

describe("challengeStatus", () => {
  it("names a live challenge Live and a disabled one Disabled", () => {
    expect(challengeStatus({}, NOW)).toEqual({ kind: "live" });
    expect(challengeStatus({ enabled: false }, NOW)).toEqual({ kind: "disabled" });
  });
});
