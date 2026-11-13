// Executes RESET_MODULE_SOLVES_SCRIPT — a contestant's classic/ai progress
// reset — against a real Redis via SRH, on run-unique keys. The mocked
// admin-ops-store suite pins which keys `resetUserProgress` hands the script;
// this one pins what the script does with them: this login's rows and totals
// go, nobody else's do, and each solved challenge's solve count drops by one.
// See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN, freshId, liveConfigured, liveKey } from "./live-redis";

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

// deleteUser against the real keyspace: every per-player key family the stores
// write is seeded for one fresh player id, and after the delete none of it is
// left, while the account (ctf:auth:*) and its GitHub link (ctf:link:*) stay —
// those belong to the account store, and removing an account is not this tool.
// The id is a fresh UUID and the team/target/challenge names are run-unique,
// so the shared aggregate hashes only ever gain and lose this test's fields.
describe.skipIf(!liveConfigured)("deleteUser against a live Redis", () => {
  const id = crypto.randomUUID();
  const mate = crypto.randomUUID();
  const login = `vt-${RUN}`.slice(0, 39);
  const tag = RUN.replace(/[^a-z0-9]/g, "");
  const slug = `vt-${tag}`.slice(0, 40);
  const target = `vt-${tag}`;
  const challenge = `vt-c-${tag}`;
  const buckets = ["team-join", "hint-reveal", "ai-submit", "ai-event", "ai-state", "ai-admin-test"];
  const at = "2026-10-01T12:00:00.000Z";

  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  /** Every key and hash field that holds this player's state, as [key, field?]. */
  const perPlayer: [string, string?][] = [
    [`ctf:user:${id}`],
    [`ctf:user:${id}:hints`],
    [`ctf:hints:at:${id}`],
    ["ctf:hints:spent", id],
    [`ctf:quiz:answers:${id}`],
    [`ctf:quiz:attempts:${id}`],
    ["ctf:quiz:points", id],
    ["ctf:quiz:answered", id],
    ["ctf:quiz:lastAt", id],
    ...(["classic", "ai"] as const).flatMap((m): [string, string?][] => [
      [`ctf:${m}:solves:${id}`],
      [`ctf:${m}:attempts:${id}`],
      [`ctf:${m}:opened:${id}`],
      [`ctf:${m}:points`, id],
      [`ctf:${m}:solved`, id],
      [`ctf:${m}:lastAt`, id],
    ]),
    [`ctf:solves:${target}`, `${id}:${challenge}`],
    ...buckets.map((b): [string, string?] => [`ctf:rl:${b}:${id}`]),
  ];

  // Runs whether or not the test passed: a delete that failed half-way must
  // not leave this run's per-player rows behind. Every key and field here is
  // named by this run's fresh id, team slug, target or challenge, so nothing
  // another suite wrote is touched.
  afterAll(async () => {
    if (!pipeline) return;
    const standalone = perPlayer.filter(([, f]) => f === undefined).map(([k]) => k);
    const fields = perPlayer.filter((p): p is [string, string] => p[1] !== undefined);
    await pipeline([
      ["DEL", ...standalone],
      ...fields.map(([k, f]) => ["HDEL", k, f]),
      ["DEL", `ctf:team:${slug}`, `ctf:team:${slug}:members`, `ctf:solves:${target}`, `ctf:user:${mate}`],
      ["DEL", `ctf:link:github:${login}`, `ctf:link:user:${id}`],
      ["HDEL", "ctf:auth:user", id],
      ["HDEL", "ctf:classic:solvecount", challenge],
      ["HDEL", "ctf:ai:solvecount", challenge],
      ["HDEL", "ctf:solves:" + target, `${mate}:${challenge}`],
      // Independent of deleteUser, so a failed assertion still leaves no
      // contestant state behind.
      ...perPlayer.map(([k, f]) => (f ? ["HDEL", k, f] : ["DEL", k])),
    ]);
  });

  it("clears every per-player key family and leaves ctf:auth:* and ctf:link:* alone", async () => {
    ({ upstashPipeline: pipeline } = await import("@/lib/upstash"));
    const { deleteUser } = await import("@/lib/admin-ops-store");

    const solveRow = JSON.stringify({ points: 10, at });
    const attemptRow = JSON.stringify({ attempts: 1, firstAt: at, lastAt: at });
    const seed: (string | number)[][] = [
      ["HSET", "ctf:auth:user", id, JSON.stringify({ id, login, name: login, email: `${login}@example.test`, image: null })],
      ["SET", `ctf:link:github:${login}`, id],
      ["SET", `ctf:link:user:${id}`, login],
      ["HSET", `ctf:team:${slug}`, "name", "VT", "captain", mate],
      ["SADD", `ctf:team:${slug}:members`, mate, id],
      ["HSET", `ctf:user:${mate}`, "team", slug],
      ["HSET", `ctf:user:${id}`, "team", slug, "joinedAt", at, "firstTeamAt", at],
      ["SADD", `ctf:user:${id}:hints`, `classic:${challenge}:0`],
      ["HSET", `ctf:hints:at:${id}`, `classic:${challenge}:0`, at],
      ["HSET", "ctf:hints:spent", id, 5],
      ["HSET", `ctf:quiz:answers:${id}`, "q1", "1"],
      ["HSET", `ctf:quiz:attempts:${id}`, "q1", attemptRow],
      ["HSET", "ctf:quiz:points", id, 10],
      ["HSET", "ctf:quiz:answered", id, 1],
      ["HSET", "ctf:quiz:lastAt", id, at],
      ["HSET", `ctf:solves:${target}`, `${id}:${challenge}`, at, `${mate}:${challenge}`, at],
      ...buckets.map((b) => ["SET", `ctf:rl:${b}:${id}`, 1, "EX", 600]),
    ];
    for (const m of ["classic", "ai"]) {
      seed.push(
        ["HSET", `ctf:${m}:solves:${id}`, challenge, solveRow],
        ["HSET", `ctf:${m}:attempts:${id}`, challenge, attemptRow],
        ["HSET", `ctf:${m}:opened:${id}`, challenge, at],
        ["HSET", `ctf:${m}:points`, id, 10],
        ["HSET", `ctf:${m}:solved`, id, 1],
        ["HSET", `ctf:${m}:lastAt`, id, at],
        ["HINCRBY", `ctf:${m}:solvecount`, challenge, 2],
      );
    }
    const seeded = await pipeline(seed);
    expect(seeded.filter((r) => r.error)).toEqual([]);

    // Every family is really there before the delete, so "gone" below proves
    // the delete removed it rather than that it was never written.
    const present = (await pipeline(perPlayer.map(([k, f]) => (f ? ["HEXISTS", k, f] : ["EXISTS", k])))).map((r) => r.result);
    expect(present).toEqual(perPlayer.map(() => 1));

    const result = await deleteUser(id, { id: crypto.randomUUID(), name: "organizer" });
    expect(result.leftTeam).toBe(slug);

    const after = await pipeline(perPlayer.map(([k, f]) => (f ? ["HEXISTS", k, f] : ["EXISTS", k])));
    expect(Object.fromEntries(perPlayer.map(([k, f], i) => [f ? `${k}#${f}` : k, after[i].result]))).toEqual(
      Object.fromEntries(perPlayer.map(([k, f]) => [f ? `${k}#${f}` : k, 0])),
    );

    const [member, mateMember, mateSolve, classicCount, aiCount, authRow, linkGithub, linkUser] = await pipeline([
      ["SISMEMBER", `ctf:team:${slug}:members`, id],
      ["SISMEMBER", `ctf:team:${slug}:members`, mate],
      ["HEXISTS", `ctf:solves:${target}`, `${mate}:${challenge}`],
      ["HGET", "ctf:classic:solvecount", challenge],
      ["HGET", "ctf:ai:solvecount", challenge],
      ["HEXISTS", "ctf:auth:user", id],
      ["GET", `ctf:link:github:${login}`],
      ["GET", `ctf:link:user:${id}`],
    ]);
    expect(member.result).toBe(0);
    expect(mateMember.result).toBe(1);
    expect(mateSolve.result).toBe(1);
    expect([classicCount.result, aiCount.result]).toEqual(["1", "1"]);
    expect(authRow.result).toBe(1);
    expect([linkGithub.result, linkUser.result]).toEqual([id, login]);
  });
});
