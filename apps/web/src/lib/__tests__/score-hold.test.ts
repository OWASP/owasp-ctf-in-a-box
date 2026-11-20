// The score hold's key names are a contract with the scorer, which pins the
// same literals in scorer/test/store.test.js: a rename on one side only would
// let a held or deleted player's score through.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval }));

import {
  AUTH_USER_ROWS_KEY,
  HOLD_SCORES_SCRIPT,
  RELEASE_SCORE_HOLD_SCRIPT,
  RESTORE_AFTER_FAILED_DELETE_SCRIPT,
  SCORE_HOLD_PREFIX,
  holdScores,
  releaseScoreHold,
  restoreAfterFailedDelete,
  scoreHoldKey,
} from "@/lib/score-hold";

const ID = "0c7aca70-0000-4000-8000-00000000000a";

beforeEach(() => mocks.upstashEval.mockReset());

describe("score-hold keys", () => {
  it("pins the literal hold prefix and account rows key the scorer reads", () => {
    expect(SCORE_HOLD_PREFIX).toBe("ctf:score-hold:");
    expect(scoreHoldKey(ID)).toBe(`ctf:score-hold:${ID}`);
    expect(AUTH_USER_ROWS_KEY).toBe("ctf:auth:user");
  });
});

describe("holdScores", () => {
  it("adds the caller's token to the hold set", async () => {
    mocks.upstashEval.mockResolvedValue(1);
    await expect(holdScores(ID, "tok-a")).resolves.toBeUndefined();
    expect(mocks.upstashEval).toHaveBeenCalledWith(HOLD_SCORES_SCRIPT, [`ctf:score-hold:${ID}`], ["tok-a"]);
    expect(HOLD_SCORES_SCRIPT).toContain("SADD");
  });

  it("throws on an unconfirmed hold", async () => {
    mocks.upstashEval.mockResolvedValue(null);
    await expect(holdScores(ID, "tok")).rejects.toThrow(/not set/);
  });
});

describe("restoreAfterFailedDelete", () => {
  it("hands the script the hold, the rows key, the id and the token", async () => {
    mocks.upstashEval.mockResolvedValue("restored");
    await expect(restoreAfterFailedDelete(ID, "tok")).resolves.toBe("restored");
    expect(mocks.upstashEval).toHaveBeenCalledWith(
      RESTORE_AFTER_FAILED_DELETE_SCRIPT,
      [`ctf:score-hold:${ID}`, "ctf:auth:user"],
      [ID, "tok"],
    );
  });

  it("passes kept and in-flight through and throws on any other reply", async () => {
    mocks.upstashEval.mockResolvedValueOnce("kept");
    await expect(restoreAfterFailedDelete(ID, "tok")).resolves.toBe("kept");
    mocks.upstashEval.mockResolvedValueOnce("in-flight");
    await expect(restoreAfterFailedDelete(ID, "tok")).resolves.toBe("in-flight");
    mocks.upstashEval.mockResolvedValueOnce(1);
    await expect(restoreAfterFailedDelete(ID, "tok")).rejects.toThrow(/unexpected reply/);
  });
});

describe("releaseScoreHold", () => {
  it("removes only the caller's token from the hold", async () => {
    mocks.upstashEval.mockResolvedValue("released");
    await expect(releaseScoreHold(ID, "tok")).resolves.toBe("released");
    expect(mocks.upstashEval).toHaveBeenCalledWith(RELEASE_SCORE_HOLD_SCRIPT, [`ctf:score-hold:${ID}`], ["tok"]);
    expect(RELEASE_SCORE_HOLD_SCRIPT).toContain("SREM");
    expect(RELEASE_SCORE_HOLD_SCRIPT).not.toContain("DEL");
  });

  it("passes in-flight through and throws on any other reply", async () => {
    mocks.upstashEval.mockResolvedValueOnce("in-flight");
    await expect(releaseScoreHold(ID, "tok")).resolves.toBe("in-flight");
    mocks.upstashEval.mockResolvedValueOnce("restored");
    await expect(releaseScoreHold(ID, "tok")).rejects.toThrow(/unexpected reply/);
  });
});
