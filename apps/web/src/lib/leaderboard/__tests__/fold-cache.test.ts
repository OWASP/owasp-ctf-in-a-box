// The folded leaderboard's invalidation token (#553): a PROCESS-local
// generation for this instance's memo, and two Redis-backed signals every app
// task can see — a score REVISION the reveal script compares the gross
// against, and an operation-in-progress COUNTER that both the balance read
// and the script reject while any score-lowering operation is running (the
// revision alone cannot cover the middle of a multi-step wipe).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import {
  SCORE_LOWERING_KEY,
  SCORE_LOWERING_TTL_S,
  SCORE_REV_KEY,
  beginScoreLowering,
  currentScoreRevision,
  endScoreLowering,
  foldGeneration,
  invalidateFoldedLeaderboard,
} from "@/lib/leaderboard/fold-cache";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upstashPipeline.mockImplementation(async (cmds) => cmds.map(() => ({ result: 1 })));
});

describe("invalidateFoldedLeaderboard (process-local)", () => {
  it("bumps this process's generation and touches nothing in Redis", () => {
    const before = foldGeneration();
    invalidateFoldedLeaderboard();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("beginScoreLowering", () => {
  it("raises the in-progress counter (with a stuck-guard TTL), bumps the revision, and drops the memo", async () => {
    const before = foldGeneration();
    await beginScoreLowering();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([
      ["INCR", SCORE_LOWERING_KEY],
      ["EXPIRE", SCORE_LOWERING_KEY, SCORE_LOWERING_TTL_S],
      ["INCR", SCORE_REV_KEY],
    ]);
  });

  it("keeps both keys out of the master reset's sweep", () => {
    // The reset wipes `ctf:solves:*`, `ctf:user:*`, `ctf:hints:*`, … but
    // keeps `ctf:admin:*` — the marker must survive the very operation it
    // guards.
    expect(SCORE_REV_KEY).toMatch(/^ctf:admin:/);
    expect(SCORE_LOWERING_KEY).toMatch(/^ctf:admin:/);
  });

  it("THROWS when the marker cannot be set — the caller must not write", async () => {
    // Fail CLOSED: without the marker, another app task still sees the old
    // revision and no in-progress flag, and could charge a hint against a
    // gross this operation is about to lower.
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    await expect(beginScoreLowering()).rejects.toThrow("upstash down");
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }, { result: 1 }, { result: 1 }]);
    await expect(beginScoreLowering()).rejects.toThrow(/NOAUTH/);
  });
});

describe("endScoreLowering", () => {
  it("lowers the counter, bumps the revision, and drops the memo", async () => {
    const before = foldGeneration();
    await endScoreLowering();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([
      ["DECR", SCORE_LOWERING_KEY],
      ["INCR", SCORE_REV_KEY],
    ]);
  });

  it("clamps the counter at 0 if the stuck-guard already expired it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: -1 }, { result: 9 }]);
    await endScoreLowering();
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["SET", SCORE_LOWERING_KEY, 0]]);
  });

  it("never throws — the operation's own outcome is what the caller reports — but logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    const before = foldGeneration();
    await expect(endScoreLowering()).resolves.toBeUndefined();
    expect(foldGeneration()).toBe(before + 1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("currentScoreRevision", () => {
  it("reads the revision and the in-progress counter together; '0' when never bumped", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }, { result: null }]);
    expect(await currentScoreRevision()).toBe("0");
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([
      ["GET", SCORE_REV_KEY],
      ["GET", SCORE_LOWERING_KEY],
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "42" }, { result: "0" }]);
    expect(await currentScoreRevision()).toBe("42");
  });

  it("rejects with ScoreLoweringInProgress while an operation is running", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "42" }, { result: "1" }]);
    await expect(currentScoreRevision()).rejects.toMatchObject({ name: "ScoreLoweringInProgress" });
  });

  it("rejects on a read error rather than guessing — the gate fails closed on it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }, { result: null }]);
    await expect(currentScoreRevision()).rejects.toThrow(/NOAUTH/);
  });
});
