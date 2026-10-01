// Unit test for the upstash source adapter's leaderboard chart contract:
// this schema (a single ZSET of current totals) has no point-in-time
// history to build a cumulative-score series from, so `series` must stay
// undefined — the leaderboard chart treats that as "hide".

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const pipelineMock = vi.fn();
vi.mock("@/lib/upstash", () => ({ upstashPipeline: (...args: unknown[]) => pipelineMock(...args) }));

import { upstashSource } from "../upstash";

afterEach(() => {
  pipelineMock.mockReset();
});

describe("upstashSource.getLeaderboard", () => {
  it("leaves series undefined — this schema has no cumulative-score history", async () => {
    // First call: ZRANGE ... WITHSCORES -> one player.
    pipelineMock.mockResolvedValueOnce([{ result: ["alice", "10"] }]);
    // Second call: HGETALL team:alice
    pipelineMock.mockResolvedValueOnce([
      { result: ["patched", "1", "total", "2", "sha", "abc123", "pr", "7", "updatedAt", "2026-07-08T10:00:00.000Z"] },
    ]);

    const data = await upstashSource.getLeaderboard();
    expect(data.entries).toHaveLength(1);
    expect(data.series).toBeUndefined();
  });

  it("reports capabilities.teams: false — no per-flag data here to dedupe a shared flag with", async () => {
    pipelineMock.mockResolvedValueOnce([{ result: [] }]);
    const data = await upstashSource.getLeaderboard();
    expect(data.capabilities.teams).toBe(false);
    expect(data.teams).toEqual([]);
  });

  // #499: a per-command error reply used to read as an empty board (ZRANGE)
  // or as zero patched for that player (HGETALL). It throws now, so the
  // caller's own fail direction applies and the log says which read failed.
  it("throws on an error reply from the ranking read", async () => {
    pipelineMock.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(upstashSource.getLeaderboard()).rejects.toThrow(/WRONGTYPE/);
  });

  it("throws on an error reply from a player's totals read", async () => {
    pipelineMock.mockResolvedValueOnce([{ result: ["alice", "10", "bob", "5"] }]);
    pipelineMock.mockResolvedValueOnce([{ result: ["patched", "1"] }, { error: "NOAUTH" }]);
    await expect(upstashSource.getLeaderboard()).rejects.toThrow(/NOAUTH/);
  });
});
