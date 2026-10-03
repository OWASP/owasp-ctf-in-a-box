// The folded leaderboard's invalidation token (#553): a PROCESS-local
// generation for this instance's memo, and two Redis-backed signals every app
// task can see — a score REVISION the reveal script compares the gross
// against, and an operation-in-progress COUNTER that both the balance read
// and the script reject while any score-lowering operation is running (the
// revision alone cannot cover the middle of a multi-step wipe).
//
// begin/end are single Lua scripts, because a pipeline is not atomic: an
// INCR that lands while the EXPIRE fails would leave a positive counter with
// no stuck-guard, the caller would never reach `end`, and every purchase
// would be refused until someone noticed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import {
  BEGIN_SCORE_LOWERING_SCRIPT,
  END_SCORE_LOWERING_SCRIPT,
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
  mocks.upstashEval.mockResolvedValue(1);
  mocks.upstashPipeline.mockResolvedValue([{ result: null }, { result: null }]);
});

describe("invalidateFoldedLeaderboard (process-local)", () => {
  it("bumps this process's generation and touches nothing in Redis", () => {
    const before = foldGeneration();
    invalidateFoldedLeaderboard();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("beginScoreLowering", () => {
  it("runs ONE atomic script over the counter and the revision, and drops the memo", async () => {
    const before = foldGeneration();
    await beginScoreLowering();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashEval).toHaveBeenCalledTimes(1);
    expect(mocks.upstashEval).toHaveBeenCalledWith(
      BEGIN_SCORE_LOWERING_SCRIPT,
      [SCORE_LOWERING_KEY, SCORE_REV_KEY],
      [SCORE_LOWERING_TTL_S],
    );
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("the script raises the counter, bumps the revision, and arms the stuck-guard only when none is armed", () => {
    // INCR + EXPIRE + INCR in one EVAL: nothing can land halfway. The TTL is
    // set only when the key has none (TTL == -1), so a counter left stuck by
    // a dead task expires 300 s after the FIRST begin, however many later
    // operations run — a later begin must not keep renewing a stale guard.
    const s = BEGIN_SCORE_LOWERING_SCRIPT;
    expect(s).toMatch(/INCR', KEYS\[1\]/);
    expect(s).toMatch(/INCR', KEYS\[2\]/);
    expect(s).toMatch(/TTL', KEYS\[1\]/);
    expect(s).toMatch(/EXPIRE', KEYS\[1\], ARGV\[1\]/);
    expect(s.indexOf("TTL")).toBeLessThan(s.indexOf("EXPIRE"));
  });

  it("the script bumps the revision FIRST, so a failure there leaves the counter untouched", () => {
    // A Lua script does not roll back: if the revision key ever held a
    // non-integer, an INCR on it throws — and were the counter raised before
    // that, it would stay raised (and blocking purchases) until the
    // stuck-guard expired, with no `end` ever running. The revision INCR is
    // the only command here that can fail on a sane key, so it goes first:
    // a throw then means NOTHING landed.
    const s = BEGIN_SCORE_LOWERING_SCRIPT;
    expect(s.indexOf("INCR', KEYS[2]")).toBeLessThan(s.indexOf("INCR', KEYS[1]"));
  });

  it("keeps both keys out of the master reset's sweep", () => {
    // The reset wipes `ctf:solves:*`, `ctf:user:*`, `ctf:hints:*`, … but
    // keeps `ctf:admin:*` — the marker must survive the very operation it
    // guards.
    expect(SCORE_REV_KEY).toMatch(/^ctf:admin:/);
    expect(SCORE_LOWERING_KEY).toMatch(/^ctf:admin:/);
  });

  it("THROWS when the script cannot run — the caller must not write", async () => {
    // Fail CLOSED: without the marker, another app task still sees the old
    // revision and no in-progress flag, and could charge a hint against a
    // gross this operation is about to lower. Atomic, so a throw means
    // NOTHING landed — no rollback to attempt.
    mocks.upstashEval.mockRejectedValueOnce(new Error("upstash down"));
    await expect(beginScoreLowering()).rejects.toThrow("upstash down");
  });
});

describe("endScoreLowering", () => {
  it("runs ONE atomic script that lowers the counter and bumps the revision, and drops the memo", async () => {
    const before = foldGeneration();
    await endScoreLowering();
    expect(foldGeneration()).toBe(before + 1);
    expect(mocks.upstashEval).toHaveBeenCalledWith(END_SCORE_LOWERING_SCRIPT, [SCORE_LOWERING_KEY, SCORE_REV_KEY], []);
  });

  it("the script deletes the counter key once no bracket is open, so the next begin arms a fresh guard", () => {
    // DECR to 0 (or below, if the stuck-guard already expired it) → DEL, not
    // "leave a 0 with a stale TTL": the next begin then finds no TTL and
    // arms a full one. Revision bumped in the same EVAL.
    const s = END_SCORE_LOWERING_SCRIPT;
    expect(s).toMatch(/DECR', KEYS\[1\]/);
    expect(s).toMatch(/<= 0/);
    expect(s).toMatch(/DEL', KEYS\[1\]/);
    expect(s).toMatch(/INCR', KEYS\[2\]/);
    // Revision first here too: the trailing bump is what outdates a fold that
    // started mid-operation, and must land even if the counter key is junk.
    expect(s.indexOf("INCR', KEYS[2]")).toBeLessThan(s.indexOf("DECR', KEYS[1]"));
  });

  it("never throws — the operation's own outcome is what the caller reports — but logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashEval.mockRejectedValueOnce(new Error("upstash down"));
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
