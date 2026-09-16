// The cross-request memo around the leaderboard fold (issue #444). What is
// worth pinning is the contract the page relies on, not the fold itself (each
// stage has its own suite): inside the TTL the fold runs once for everyone;
// concurrent callers share one in-flight fold; a fold that throws is never
// cached, so a blip costs one slow page and not ten seconds of a frozen board.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getFoldedLeaderboard, LEADERBOARD_FOLD_TTL_MS, resetFoldedLeaderboardCache } from "@/lib/leaderboard/folded";
import type { LeaderboardData } from "@/lib/leaderboard/types";

const board = (tag: string): LeaderboardData => ({
  entries: [],
  teams: [],
  generatedAt: tag,
  capabilities: { apps: false, teams: false, challenges: false },
});

const NOW = 1_800_000_000_000;
/** A fixed clock for the tests that do not move time during the fold. */
const at = (ms: number) => () => ms;

beforeEach(() => {
  resetFoldedLeaderboardCache();
});

describe("getFoldedLeaderboard", () => {
  it("runs the fold once inside the TTL and hands every caller the same data", async () => {
    const fold = vi.fn(async () => board("a"));
    const first = await getFoldedLeaderboard({ now: at(NOW), fold });
    const second = await getFoldedLeaderboard({ now: at(NOW + LEADERBOARD_FOLD_TTL_MS - 1), fold });
    expect(fold).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("re-runs the fold once the TTL has passed", async () => {
    const fold = vi.fn().mockResolvedValueOnce(board("a")).mockResolvedValueOnce(board("b"));
    await getFoldedLeaderboard({ now: at(NOW), fold });
    const later = await getFoldedLeaderboard({ now: at(NOW + LEADERBOARD_FOLD_TTL_MS), fold });
    expect(fold).toHaveBeenCalledTimes(2);
    expect(later.generatedAt).toBe("b");
  });

  // A room of viewers landing in the same second used to mean N folds; they
  // must share the one that is already running.
  it("coalesces concurrent callers onto one in-flight fold", async () => {
    let release!: (b: LeaderboardData) => void;
    const fold = vi.fn(() => new Promise<LeaderboardData>((r) => (release = r)));
    const calls = [getFoldedLeaderboard({ now: at(NOW), fold }), getFoldedLeaderboard({ now: at(NOW + 1), fold }), getFoldedLeaderboard({ now: at(NOW + 2), fold })];
    release(board("shared"));
    const results = await Promise.all(calls);
    expect(fold).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe(results[2]);
  });

  // Fail-open, never cache a failure: the next caller retries immediately.
  it("does not cache a fold that threw, and retries on the next call", async () => {
    const fold = vi.fn().mockRejectedValueOnce(new Error("redis blip")).mockResolvedValueOnce(board("ok"));
    await expect(getFoldedLeaderboard({ now: at(NOW), fold })).rejects.toThrow("redis blip");
    const next = await getFoldedLeaderboard({ now: at(NOW + 1), fold });
    expect(next.generatedAt).toBe("ok");
    expect(fold).toHaveBeenCalledTimes(2);
  });

  it("a rejected in-flight fold rejects every caller sharing it, then clears", async () => {
    let reject!: (e: Error) => void;
    const fold = vi.fn().mockImplementationOnce(() => new Promise<LeaderboardData>((_, rj) => (reject = rj))).mockResolvedValueOnce(board("after"));
    const a = getFoldedLeaderboard({ now: at(NOW), fold });
    const b = getFoldedLeaderboard({ now: at(NOW + 1), fold });
    reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect((await getFoldedLeaderboard({ now: at(NOW + 2), fold })).generatedAt).toBe("after");
  });

  // A fold slower than the TTL used to be stored already expired: `at` was
  // stamped when the fold was requested, so the next request folded again at
  // once, and a slow box became a queue of back-to-back folds.
  it("starts the TTL when the fold finishes, so a slow fold is still served", async () => {
    let clock = NOW;
    const now = () => clock;
    const fold = vi.fn(async () => {
      clock += LEADERBOARD_FOLD_TTL_MS + 5_000; // the fold itself outlives the TTL
      return board("slow");
    });
    const first = await getFoldedLeaderboard({ now, fold });
    clock += LEADERBOARD_FOLD_TTL_MS - 1; // just inside the TTL from COMPLETION
    const second = await getFoldedLeaderboard({ now, fold });
    expect(fold).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("keeps the TTL short enough that no viewer sees older data than the display board already refreshes at", () => {
    expect(LEADERBOARD_FOLD_TTL_MS).toBeLessThanOrEqual(30_000);
    expect(LEADERBOARD_FOLD_TTL_MS).toBeGreaterThanOrEqual(5_000);
  });
});
