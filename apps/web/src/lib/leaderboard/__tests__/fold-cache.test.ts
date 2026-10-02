// The folded leaderboard's invalidation token (#553): a PROCESS-local
// generation for this instance's memo, and a Redis-backed score revision
// every app task can see — the reveal script refuses a charge whose gross was
// folded under a revision that has since moved (a reset or a module switched
// off on another task while the fold ran).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import {
  SCORE_REV_KEY,
  currentScoreRevision,
  foldGeneration,
  invalidateFoldedLeaderboard,
} from "@/lib/leaderboard/fold-cache";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upstashPipeline.mockResolvedValue([{ result: 1 }]);
});

describe("invalidateFoldedLeaderboard", () => {
  it("bumps this process's generation and INCRs the shared score revision", async () => {
    const before = foldGeneration();
    await invalidateFoldedLeaderboard();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["INCR", SCORE_REV_KEY]]);
  });

  it("keeps the key out of the master reset's sweep", () => {
    // The reset wipes `ctf:solves:*`, `ctf:user:*`, `ctf:hints:*`, … but
    // keeps `ctf:admin:*`. A revision the reset deleted would restart at 1 —
    // still ≠ the old value, so still safe — but a counter should not reset.
    expect(SCORE_REV_KEY).toMatch(/^ctf:admin:/);
  });

  it("still bumps the generation when the Redis bump throws, and logs it", async () => {
    // This instance's memo must drop regardless; the other tasks lose the
    // signal for this one write, which the error line makes visible.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    const before = foldGeneration();
    await expect(invalidateFoldedLeaderboard()).resolves.toBeUndefined();
    expect(foldGeneration()).toBe(before + 1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("treats a per-command error on the bump the same way", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(invalidateFoldedLeaderboard()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("currentScoreRevision", () => {
  it("reads the shared revision, '0' when it has never been bumped", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await currentScoreRevision()).toBe("0");
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["GET", SCORE_REV_KEY]]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "42" }]);
    expect(await currentScoreRevision()).toBe("42");
  });

  it("rejects on a read error rather than guessing — the gate fails closed on it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(currentScoreRevision()).rejects.toThrow(/NOAUTH/);
  });
});
