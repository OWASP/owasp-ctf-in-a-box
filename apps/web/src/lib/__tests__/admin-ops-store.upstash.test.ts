// Executes RESET_MODULE_SOLVES_SCRIPT — a contestant's classic/ai progress
// reset — against a real Redis via SRH, on run-unique keys. The mocked
// admin-ops-store suite pins which keys `resetUserProgress` hands the script;
// this one pins what the script does with them: this login's rows and totals
// go, nobody else's do, and each solved challenge's solve count drops by one.
// See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("RESET_MODULE_SOLVES_SCRIPT against a live Redis", () => {
  const K = {
    points: liveKey("reset", "points"),
    solved: liveKey("reset", "solved"),
    solvecount: liveKey("reset", "solvecount"),
    lastAt: liveKey("reset", "lastAt"),
  };
  const perLogin: string[] = [];

  let script: string;
  let upstashEval: (typeof import("@/lib/upstash"))["upstashEval"];
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  async function load() {
    if (script) return;
    ({ RESET_MODULE_SOLVES_SCRIPT: script } = await import("@/lib/admin-ops-store"));
    ({ upstashEval, upstashPipeline: pipeline } = await import("@/lib/upstash"));
  }

  afterAll(async () => {
    if (pipeline) await pipeline([["DEL", ...Object.values(K), ...perLogin]]);
  });

  /** One login's classic/ai-shaped progress: a solves row per id, an attempts
   *  row, the two totals, the award time, and a solve count per id. */
  async function seedLogin(login: string, ids: string[]) {
    await load();
    const solves = liveKey("reset", freshId("solves"));
    const attempts = liveKey("reset", freshId("attempts"));
    perLogin.push(solves, attempts);
    const cmds: (string | number)[][] = [
      ["HSET", K.points, login, 10 * ids.length],
      ["HSET", K.solved, login, ids.length],
      ["HSET", K.lastAt, login, "2026-10-01T12:00:00.000Z"],
      ["HSET", attempts, ids[0], '{"attempts":1}'],
    ];
    for (const id of ids) {
      cmds.push(["HSET", solves, id, '{"points":10,"at":"2026-10-01T12:00:00.000Z"}']);
      cmds.push(["HINCRBY", K.solvecount, id, 1]);
    }
    await pipeline(cmds);
    return { solves, attempts };
  }

  async function run(login: string, keys: { solves: string; attempts: string }) {
    return upstashEval(script, [keys.solves, keys.attempts, K.points, K.solved, K.solvecount, K.lastAt], [login]);
  }

  async function hget(key: string, field: string) {
    const [r] = await pipeline([["HGET", key, field]]);
    return r.result;
  }

  it("clears this login's rows, totals and award time, and decrements each solved challenge once", async () => {
    const ada = freshId("ada");
    const bob = freshId("bob");
    const [c1, c2] = [freshId("c"), freshId("c")];
    const adaKeys = await seedLogin(ada, [c1, c2]);
    await seedLogin(bob, [c1]);

    expect(await run(ada, adaKeys)).toEqual([1, 1, 1, 1, 2]);

    expect(await hget(K.points, ada)).toBeNull();
    expect(await hget(K.solved, ada)).toBeNull();
    // #522: the award time goes with the totals it orders.
    expect(await hget(K.lastAt, ada)).toBeNull();
    const [solvesLeft, attemptsLeft] = await pipeline([["EXISTS", adaKeys.solves], ["EXISTS", adaKeys.attempts]]);
    expect([solvesLeft.result, attemptsLeft.result]).toEqual([0, 0]);
    // c1 was solved by both; c2 by ada alone.
    expect(await hget(K.solvecount, c1)).toBe("1");
    expect(await hget(K.solvecount, c2)).toBe("0");
  });

  it("leaves every other login's totals and award time alone", async () => {
    const ada = freshId("ada");
    const bob = freshId("bob");
    const c1 = freshId("c");
    const adaKeys = await seedLogin(ada, [c1]);
    await seedLogin(bob, [c1]);

    await run(ada, adaKeys);

    expect(await hget(K.points, bob)).toBe("10");
    expect(await hget(K.solved, bob)).toBe("1");
    expect(await hget(K.lastAt, bob)).toBe("2026-10-01T12:00:00.000Z");
  });
});
