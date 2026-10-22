// Executes the feed's RECORD_SCRIPT against a real Redis via SRH. The mocked
// suite pins what `recordRecentSolve` passes in; this pins what the script
// does with it: the team-plus-item dedupe polarity and the paired trim of the
// sorted set and the data hash.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("recent-solves RECORD_SCRIPT against a live Redis", () => {
  const K = {
    zset: liveKey("recent-solves", "zset"),
    data: liveKey("recent-solves", "data"),
  };
  let script: string;
  let evalRedis: (typeof import("@/lib/upstash"))["upstashEval"];
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  async function load() {
    if (script) return;
    ({ RECORD_SCRIPT: script } = await import("@/lib/recent-solves"));
    ({ upstashEval: evalRedis, upstashPipeline: pipeline } = await import("@/lib/upstash"));
  }

  beforeEach(async () => {
    await load();
    await pipeline([["DEL", ...Object.values(K)]]);
  });

  afterAll(async () => {
    if (pipeline) await pipeline([["DEL", ...Object.values(K)]]);
  });

  async function write(id: string, score: number, event: unknown, max: number) {
    await load();
    return evalRedis(script, [K.zset, K.data], [id, String(score), JSON.stringify(event), String(max)]);
  }

  it("adds without trimming while the feed is under the cap", async () => {
    const prefix = liveKey("recent-solves", "under");
    for (let i = 0; i < 10; i++) {
      expect(await write(`${prefix}:${i}`, 1000 + i, { n: i }, 50)).toBe(1);
    }

    const [zcard] = await pipeline([["ZCARD", K.zset]]);
    const [hlen] = await pipeline([["HLEN", K.data]]);
    expect(zcard.result).toBe(10);
    expect(hlen.result).toBe(10);
  });

  it("adds a fresh id once and reports a replay as a no-op", async () => {
    const id = liveKey("recent-solves", "dedupe");
    const event = { module: "classic", challengeId: "c1", points: 10, team: "red", teamName: "Red", at: "2026-08-24T10:00:00.000Z" };
    expect(await write(id, 1000, event, 50)).toBe(1);
    for (let i = 0; i < 5; i++) {
      expect(await write(id, 2000 + i, { ...event, points: 999 }, 50)).toBe(0);
    }

    const [score] = await pipeline([["ZSCORE", K.zset, id]]);
    const [data] = await pipeline([["HGET", K.data, id]]);
    const [zcard] = await pipeline([["ZCARD", K.zset]]);
    const [hlen] = await pipeline([["HLEN", K.data]]);
    expect(score.result).toBe("1000"); // replay did not move it
    expect(JSON.parse(String(data.result)).points).toBe(10); // nor rewrite the row
    expect(zcard.result).toBe(1);
    expect(hlen.result).toBe(1);
  });

  it("trims the sorted set and the data hash together", async () => {
    const prefix = liveKey("recent-solves", "trim");
    for (let i = 0; i < 5; i++) {
      expect(await write(`${prefix}:${i}`, 1000 + i, { n: i }, 3)).toBe(1);
    }

    const [zcard] = await pipeline([["ZCARD", K.zset]]);
    const [members] = await pipeline([["ZRANGE", K.zset, 0, -1]]);
    const [hlen] = await pipeline([["HLEN", K.data]]);
    const [keys] = await pipeline([["HKEYS", K.data]]);
    expect(zcard.result).toBe(3);
    expect(members.result).toEqual([`${prefix}:2`, `${prefix}:3`, `${prefix}:4`]);
    expect(hlen.result).toBe(3);
    expect((keys.result as string[]).sort()).toEqual([`${prefix}:2`, `${prefix}:3`, `${prefix}:4`]);
  });

  it("keeps the newest 50 and drops their data rows at the production cap", async () => {
    const prefix = liveKey("recent-solves", "max");
    for (let i = 0; i < 55; i++) {
      expect(await write(`${prefix}:${i}`, 1000 + i, { n: i }, 50)).toBe(1);
    }

    const kept = Array.from({ length: 50 }, (_, i) => `${prefix}:${i + 5}`);
    const [zcard] = await pipeline([["ZCARD", K.zset]]);
    const [members] = await pipeline([["ZRANGE", K.zset, 0, -1]]);
    const [hlen] = await pipeline([["HLEN", K.data]]);
    const [keys] = await pipeline([["HKEYS", K.data]]);
    const [newest] = await pipeline([["HGET", K.data, `${prefix}:54`]]);
    expect(zcard.result).toBe(50);
    expect(members.result).toEqual(kept);
    expect(hlen.result).toBe(50);
    expect((keys.result as string[]).sort()).toEqual([...kept].sort());
    expect(JSON.parse(String(newest.result))).toEqual({ n: 54 });
  });
});
