// Unit tests for the per-login rate limiter. Two things matter: the verdict
// the caller acts on, and the Lua script's window semantics — which is where
// a plausible-looking limiter goes wrong (an EXPIRE refreshed on every
// request makes a window that never ends, so a steady stream is throttled
// forever). Upstash is mocked; a small fake interprets the script's contract.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANTED_LOG_SECRET, decoratedError, expectLabelOnly } from "./log-redaction";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval }));

import { RATE_LIMITS, consumeRateLimit } from "@/lib/rate-limit-store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consumeRateLimit", () => {
  it("allows when the script says the budget is intact", async () => {
    mocks.upstashEval.mockResolvedValueOnce([1, 0]);
    expect(await consumeRateLimit("b", "alice", 10, 600)).toEqual({ allowed: true });
  });

  it("refuses with the key's real remaining TTL", async () => {
    mocks.upstashEval.mockResolvedValueOnce([0, 137]);
    expect(await consumeRateLimit("b", "alice", 10, 600)).toEqual({ allowed: false, retryAfterSeconds: 137 });
  });

  it("never answers Retry-After: 0, which would read as 'retry now'", async () => {
    mocks.upstashEval.mockResolvedValueOnce([0, 0]);
    expect(await consumeRateLimit("b", "alice", 10, 600)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("keys per bucket and per login, case-insensitively", async () => {
    // GitHub logins are case-insensitive; two spellings must share a budget
    // or the limit is trivially doubled by changing case.
    mocks.upstashEval.mockResolvedValue([1, 0]);
    await consumeRateLimit("team-join", "Alice", 10, 600);
    expect(mocks.upstashEval.mock.calls[0][1]).toEqual(["ctf:rl:team-join:alice"]);
    await consumeRateLimit("hint-reveal", "alice", 30, 60);
    expect(mocks.upstashEval.mock.calls[1][1]).toEqual(["ctf:rl:hint-reveal:alice"]);
  });

  // Opposite of consumeGateAttempt, deliberately. That one guards a password
  // compare and fails CLOSED. These bound abuse of routes with their own
  // correctness gates underneath, so a Redis blip must not stop contestants
  // playing.
  it("fails OPEN when Upstash errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashEval.mockRejectedValueOnce(new Error("upstash down"));
    expect(await consumeRateLimit("b", "alice", 10, 600)).toEqual({ allowed: true });
    // Failing open silently is how a disabled control goes unnoticed.
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  // The shared label, not a bespoke `.message` read: capped, so an error
  // whose message quotes the request cannot carry it past 200 characters
  // into the log (#500 follow-up).
  it("logs the capped label, never the full message or the decoration", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.upstashEval.mockRejectedValueOnce(decoratedError(`upstash down ${"x".repeat(250)} ${PLANTED_LOG_SECRET}`));
      expect(await consumeRateLimit("b", "alice", 10, 600)).toEqual({ allowed: true });
      expectLabelOnly(err);
    } finally {
      err.mockRestore();
    }
  });

  it("allows rather than throwing on an unexpected reply shape", async () => {
    mocks.upstashEval.mockResolvedValueOnce(null);
    expect(await consumeRateLimit("b", "alice", 10, 600)).toEqual({ allowed: true });
  });
});

// The script is the actual control; the wrapper above is bookkeeping around
// it. This runs it against a fake Redis that honours the three commands it
// uses.
//
// BE HONEST ABOUT WHAT THIS PROVES. The fake encodes the contract the Lua is
// written to, not the Lua itself — a test suite cannot execute Redis's script
// engine. The script was therefore also run against the real thing, against
// the stack's own `redis` container:
//
//   limit 3 / window 60 → calls 1-3 return {1,0}, call 4 returns {0,60}
//   window forced to 10s mid-stream → two further calls leave TTL at 10,
//     and the refusal reports 10, not 60
//
// That second case is the one that matters and the one a fake cannot
// establish on its own: it proves EXPIRE is not re-applied on every request.
// Re-run it after any change to CONSUME_SCRIPT.
describe("the fixed-window script", () => {
  /** Minimal Redis stand-in: INCR, EXPIRE, TTL over one key. */
  function fakeRedis() {
    let value = 0;
    let ttl = -2; // redis: -2 = no key, -1 = key with no expiry
    return {
      run(_script: string, _keys: string[], args: (string | number)[]) {
        const [limit, windowSeconds] = args.map(Number);
        value += 1;
        if (value === 1) ttl = windowSeconds;
        if (value > limit) return [0, ttl < 0 ? windowSeconds : ttl];
        return [1, 0];
      },
      /** What the key's TTL is now — the assertion target below. */
      ttl: () => ttl,
      expireWindow() {
        value = 0;
        ttl = -2;
      },
    };
  }

  async function drive(redis: ReturnType<typeof fakeRedis>, times: number, limit: number, window: number) {
    const verdicts = [];
    for (let i = 0; i < times; i++) {
      mocks.upstashEval.mockImplementationOnce(async (s, k, a) => redis.run(s, k, a));
      verdicts.push(await consumeRateLimit("b", "alice", limit, window));
    }
    return verdicts;
  }

  it("allows exactly `limit` requests, then refuses", async () => {
    const redis = fakeRedis();
    const verdicts = await drive(redis, 12, 10, 600);
    expect(verdicts.slice(0, 10).every((v) => v.allowed)).toBe(true);
    expect(verdicts[10]).toEqual({ allowed: false, retryAfterSeconds: 600 });
    expect(verdicts[11].allowed).toBe(false);
  });

  it("sets the window on the FIRST request only", async () => {
    // The bug this pins: refreshing EXPIRE on every request makes the window
    // never end, so a steady stream of calls is throttled permanently rather
    // than recovering. The TTL must still be the one set at request 1.
    const redis = fakeRedis();
    await drive(redis, 5, 10, 600);
    expect(redis.ttl()).toBe(600);
  });

  it("starts a fresh budget once the window has lapsed", async () => {
    const redis = fakeRedis();
    await drive(redis, 11, 10, 600);
    redis.expireWindow(); // Redis deleted the key when its TTL ran out
    const [after] = await drive(redis, 1, 10, 600);
    expect(after.allowed).toBe(true);
  });
});

describe("the configured budgets", () => {
  it("sit well above any human pace", () => {
    // A contestant clicking through every hint on a page must never hit this,
    // or the control becomes a bug report instead of a defence.
    expect(RATE_LIMITS.hintReveal.limit).toBeGreaterThanOrEqual(30);
    expect(RATE_LIMITS.teamJoin.limit).toBeGreaterThanOrEqual(5);
  });

  it("uses distinct buckets so one route cannot exhaust the other's budget", () => {
    expect(RATE_LIMITS.teamJoin.bucket).not.toBe(RATE_LIMITS.hintReveal.bucket);
  });
});
