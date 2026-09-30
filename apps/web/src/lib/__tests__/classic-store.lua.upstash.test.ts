// Executes classic's SUBMIT_SCRIPT — the grading authority — against a real
// Redis via SRH. The mocked grade suite pins what `submitFlag` hands the
// script (key and argument order); this one pins what the script does with
// it. Each test seeds its own run-unique keys, so nothing here can collide
// with another suite or a previous run. See live-redis.ts for the harness.
//
// Every assertion below was chosen because a mutation that survives the
// mocked suite would flip it: the HEXISTS polarity (a re-solve farming
// points), `and lastAtMs` (a crash on every first-ever submission when a
// cooldown is set), the cooldown comparison, solvecount keyed by the login
// instead of the challenge, and the case-sensitive form selection.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attemptsRow, freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00:00.000Z
const iso = (ms: number) => new Date(ms).toISOString();

describe.skipIf(!liveConfigured)("classic SUBMIT_SCRIPT against a live Redis", () => {
  const K = {
    attempts: liveKey("classic", "attempts"),
    solves: liveKey("classic", "solves"),
    flagnorm: liveKey("classic", "flagnorm"),
    challenges: liveKey("classic", "challenges"),
    points: liveKey("classic", "points"),
    solvecount: liveKey("classic", "solvecount"),
    solved: liveKey("classic", "solved"),
    lastAt: liveKey("classic", "lastAt"),
  };
  // Per test, so no total asserted here can be inflated by an earlier test.
  let LOGIN = "";
  beforeEach(() => {
    LOGIN = freshId("alice");
  });

  let script: string;
  let upstashEval: (typeof import("@/lib/upstash"))["upstashEval"];
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];
  let keys: typeof import("@/lib/classic-keys");

  async function load() {
    if (script) return;
    ({ SUBMIT_SCRIPT: script } = await import("@/lib/classic-store"));
    ({ upstashEval, upstashPipeline: pipeline } = await import("@/lib/upstash"));
    keys = await import("@/lib/classic-keys");
  }

  afterAll(async () => {
    if (pipeline) await pipeline([["DEL", ...Object.values(K)]]);
  });

  /** Seeds a challenge the way `upsertChallenge` does: the comparison form of
   *  the flag into flagnorm, the record (points, optional caseSensitive) into
   *  challenges. */
  async function seed(id: string, flag: string, points: number, caseSensitive?: true) {
    await load();
    const record = caseSensitive ? { id, title: id, points, caseSensitive } : { id, title: id, points };
    await pipeline([
      ["HSET", K.flagnorm, id, keys.flagComparisonForm(flag, caseSensitive)],
      ["HSET", K.challenges, id, JSON.stringify(record)],
    ]);
  }

  /** Runs the script exactly as `submitFlag` does, with both comparison forms. */
  async function submit(
    id: string,
    flag: string,
    {
      nowMs = T0,
      cooldownMs = 5_000,
      login = LOGIN,
      dry = false,
      prereq = "",
      teamSolveKeys = [] as string[],
    } = {},
  ) {
    await load();
    return upstashEval(
      script,
      [K.attempts, K.solves, K.flagnorm, K.challenges, K.points, K.solvecount, K.solved, K.lastAt, ...teamSolveKeys],
      [
        id,
        keys.normalizeFlag(flag),
        iso(nowMs),
        login,
        cooldownMs,
        nowMs,
        keys.caseSensitiveFlagForm(flag),
        dry ? "1" : "0",
        prereq, // ARGV[9] — #463 story prerequisite ("" = none)
      ],
    );
  }

  async function hget(key: string, field: string) {
    const [r] = await pipeline([["HGET", key, field]]);
    return r.result;
  }

  // #522: the leaderboard's "whoever got there first" tiebreak reads this.
  it("stamps the login's last award time, and only an award moves it", async () => {
    const first = freshId("c");
    const second = freshId("c");
    await seed(first, "flag{one}", 20);
    await seed(second, "flag{two}", 10);
    expect(await hget(K.lastAt, LOGIN)).toBeNull();
    expect(await submit(first, "flag{one}", { cooldownMs: 0 })).toEqual(["correct", "20"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0));
    // A miss, a repeat of a banked flag and a dry-run award leave it alone.
    expect(await submit(second, "flag{nope}", { nowMs: T0 + 1_000, cooldownMs: 0 })).toEqual(["incorrect", "1"]);
    expect(await submit(first, "flag{one}", { nowMs: T0 + 2_000, cooldownMs: 0 })).toEqual(["already"]);
    expect(await submit(second, "flag{two}", { nowMs: T0 + 3_000, cooldownMs: 0, dry: true })).toEqual(["correct", "10", "dry"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0));
    expect(await submit(second, "flag{two}", { nowMs: T0 + 4_000, cooldownMs: 0 })).toEqual(["correct", "10"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0 + 4_000));
  });

  it("returns missing for an unknown challenge and writes no attempts row", async () => {
    const id = freshId("ghost");
    expect(await submit(id, "anything")).toEqual(["missing"]);
    expect(await hget(K.attempts, id)).toBeNull();
  });

  it("grades a FIRST-EVER wrong submission with a cooldown set — no attempts row yet, so lastAtMs is nil", async () => {
    // Dropping `and lastAtMs` from the cooldown guard makes this arithmetic
    // on nil and 500s every contestant's first submission.
    const id = freshId("chal");
    await seed(id, "flag{right}", 25);
    expect(await submit(id, "flag{wrong}", { cooldownMs: 5_000 })).toEqual(["incorrect", "1"]);
    expect(await hget(K.attempts, id)).toBe(attemptsRow(1, iso(T0), iso(T0), T0));
    expect(await hget(K.solves, id)).toBeNull();
  });

  it("awards a correct submission once: solve row, login totals, and solvecount keyed by the CHALLENGE", async () => {
    const id = freshId("chal");
    await seed(id, "flag{right}", 25);
    expect(await submit(id, "FLAG{RIGHT}  ")).toEqual(["correct", "25"]);
    expect(await hget(K.solves, id)).toBe(`{"points":25,"at":"${iso(T0)}"}`);
    expect(await hget(K.points, LOGIN)).toBe("25");
    expect(await hget(K.solved, LOGIN)).toBe("1");
    // The per-challenge solve count is keyed by challenge id — a login-keyed
    // increment is the mutation this pair of asserts exists for.
    expect(await hget(K.solvecount, id)).toBe("1");
    expect(await hget(K.solvecount, LOGIN)).toBeNull();
  });

  it("refuses to re-award a solved challenge: `already`, and every counter stays put", async () => {
    const id = freshId("chal");
    await seed(id, "flag{right}", 25);
    expect(await submit(id, "flag{right}")).toEqual(["correct", "25"]);
    const before = await pipeline([
      ["HGET", K.points, LOGIN],
      ["HGET", K.solved, LOGIN],
      ["HGET", K.solvecount, id],
      ["HGET", K.attempts, id],
    ]);
    expect(await submit(id, "flag{right}", { nowMs: T0 + 60_000 })).toEqual(["already"]);
    const after = await pipeline([
      ["HGET", K.points, LOGIN],
      ["HGET", K.solved, LOGIN],
      ["HGET", K.solvecount, id],
      ["HGET", K.attempts, id],
    ]);
    expect(after).toEqual(before);
  });

  it("enforces the cooldown from the row it reads: refused one ms before the boundary, graded at it", async () => {
    const id = freshId("chal");
    await seed(id, "flag{right}", 10);
    expect(await submit(id, "flag{nope}", { nowMs: T0, cooldownMs: 5_000 })).toEqual(["incorrect", "1"]);
    expect(await submit(id, "flag{nope}", { nowMs: T0 + 4_999, cooldownMs: 5_000 })).toEqual([
      "cooldown",
      String(T0 + 5_000),
    ]);
    // A refused submission is not an attempt: the row is untouched.
    expect(await hget(K.attempts, id)).toBe(attemptsRow(1, iso(T0), iso(T0), T0));
    expect(await submit(id, "flag{nope}", { nowMs: T0 + 5_000, cooldownMs: 5_000 })).toEqual(["incorrect", "2"]);
  });

  it("carries firstAt forward across rewrites of the attempts row, and a zero cooldown never refuses", async () => {
    const id = freshId("chal");
    await seed(id, "flag{right}", 10);
    expect(await submit(id, "a", { nowMs: T0, cooldownMs: 0 })).toEqual(["incorrect", "1"]);
    expect(await submit(id, "b", { nowMs: T0 + 1, cooldownMs: 0 })).toEqual(["incorrect", "2"]);
    expect(await hget(K.attempts, id)).toBe(attemptsRow(2, iso(T0), iso(T0 + 1), T0 + 1));
  });

  it("compares the case-preserved form only when the challenge is marked caseSensitive", async () => {
    const strict = freshId("strict");
    await seed(strict, "SeCrEt{Flag}", 7, true);
    // Same letters, wrong case: the forgiving form would match, the strict one must not.
    expect(await submit(strict, "secret{flag}")).toEqual(["incorrect", "1"]);
    expect(await submit(strict, "SeCrEt{Flag}", { nowMs: T0 + 10_000 })).toEqual(["correct", "7"]);

    const lax = freshId("lax");
    await seed(lax, "SeCrEt{Flag}", 3);
    expect(await submit(lax, "secret{flag}")).toEqual(["correct", "3"]);
  });

  // #464 admin preview: a DRY run goes through this same script, grades, and
  // writes NOTHING. Every key the script can touch is snapshotted around it.
  async function snapshot() {
    await load();
    const replies = await pipeline(Object.values(K).map((k) => ["HGETALL", k]));
    // As sorted field maps: HGETALL's field ORDER is not stable across a
    // hash's re-encoding, only its contents are.
    return replies.map(({ result }) => {
      const flat = (result as string[] | null) ?? [];
      const pairs: [string, string][] = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
      return Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)));
    });
  }

  it("dry run: grades a correct flag and writes nothing at all", async () => {
    const id = freshId("dry-ok");
    await seed(id, "flag{right}", 25);
    const before = await snapshot();
    expect(await submit(id, "flag{right}", { dry: true })).toEqual(["correct", "25", "dry"]);
    expect(await snapshot()).toEqual(before);
  });

  it("dry run: grades a wrong flag without recording an attempt", async () => {
    const id = freshId("dry-wrong");
    await seed(id, "flag{right}", 25);
    const before = await snapshot();
    expect(await submit(id, "flag{nope}", { dry: true })).toEqual(["incorrect", "0", "dry"]);
    expect(await snapshot()).toEqual(before);
  });

  it("dry run: ignores a cooldown (nothing is recorded, so nothing to cool)", async () => {
    const id = freshId("dry-cool");
    await seed(id, "flag{right}", 25);
    expect(await submit(id, "flag{nope}", { nowMs: T0, cooldownMs: 60_000 })).toEqual(["incorrect", "1"]);
    expect(await submit(id, "flag{right}", { nowMs: T0 + 1, cooldownMs: 60_000, dry: true })).toEqual(["correct", "25", "dry"]);
  });

  it("dry run: still refuses an unknown challenge and an already-solved one", async () => {
    const id = freshId("dry-guards");
    expect(await submit(id, "x", { dry: true })).toEqual(["missing"]);
    await seed(id, "flag{right}", 25);
    expect(await submit(id, "flag{right}")).toEqual(["correct", "25"]);
    expect(await submit(id, "flag{right}", { nowMs: T0 + 60_000, dry: true })).toEqual(["already"]);
  });

  it("anti-vacuous: the SAME submission without dry run does write a solve", async () => {
    const id = freshId("dry-anti");
    await seed(id, "flag{right}", 25);
    expect(await submit(id, "flag{right}", { dry: true })).toEqual(["correct", "25", "dry"]);
    const before = await snapshot();
    expect(await submit(id, "flag{right}")).toEqual(["correct", "25"]);
    expect(await snapshot()).not.toEqual(before);
    expect(await hget(K.solves, id)).toBe(`{"points":25,"at":"${iso(T0)}"}`);
  });

  // #463 stories: a step is locked until a TEAMMATE (any of the solves hashes
  // handed in) has solved its prerequisite — decided in the script, before any
  // write, so a locked step costs no attempt and is no flag oracle.
  it("story lock: refuses a locked step with `locked`, writing nothing — then grades the SAME flag once a teammate solved the prerequisite", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(id, "flag{web}", 40);
    const teammate = liveKey("classic", freshId("solves-bob"));
    const before = await snapshot();
    expect(await submit(id, "flag{web}", { prereq: prereqId, teamSolveKeys: [K.solves, teammate] })).toEqual(["locked"]);
    expect(await snapshot()).toEqual(before);

    // A NON-teammate's solve does not count — only the keys the caller hands in.
    const stranger = liveKey("classic", freshId("solves-eve"));
    await pipeline([["HSET", stranger, prereqId, '{"points":1,"at":"x"}']]);
    expect(await submit(id, "flag{web}", { prereq: prereqId, teamSolveKeys: [K.solves, teammate] })).toEqual(["locked"]);

    // The teammate solves the prerequisite: the same flag now grades.
    await pipeline([["HSET", teammate, prereqId, '{"points":10,"at":"x"}']]);
    expect(await submit(id, "flag{web}", { prereq: prereqId, teamSolveKeys: [K.solves, teammate] })).toEqual(["correct", "40"]);
    await pipeline([["DEL", teammate, stranger]]);
  });

  // The time is taken in JS before the script runs, so two awards can reach
  // Redis out of order. The later time must survive the earlier write.
  it("keeps the later award time when two awards land out of order", async () => {
    const later = freshId("c");
    const earlier = freshId("c");
    await seed(later, "flag{later}", 20);
    await seed(earlier, "flag{earlier}", 10);
    expect(await submit(later, "flag{later}", { nowMs: T0 + 5_000, cooldownMs: 0 })).toEqual(["correct", "20"]);
    expect(await submit(earlier, "flag{earlier}", { nowMs: T0 + 1_000, cooldownMs: 0 })).toEqual(["correct", "10"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0 + 5_000));
  });

  // #522 moved the lock keys from KEYS[8..] to KEYS[9..] to make room for
  // the lastAt hash. If the loop still started at 8 it would read that hash
  // as a teammate's solves, and a field named like the prerequisite would
  // open the step.
  it("story lock: the lastAt hash is never read as a teammate's solves", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(id, "flag{web}", 40);
    await pipeline([["HSET", K.lastAt, prereqId, iso(T0)]]);
    expect(await submit(id, "flag{web}", { prereq: prereqId, teamSolveKeys: [K.solves] })).toEqual(["locked"]);
    await pipeline([["HDEL", K.lastAt, prereqId]]);
  });

  // CodeRabbit #470 (secrecy boundary): the lock is checked BEFORE the
  // script reads the flag hash — observable as a locked id with no flag at
  // all answering `locked`, not `missing` (both reach a contestant as the
  // same 404). Without a prerequisite, an unknown id is still `missing`.
  it("story lock: checked before any flag read; a dry-run preview skips the lock", async () => {
    expect(await submit(freshId("ghost"), "x", { prereq: "p", teamSolveKeys: [K.solves] })).toEqual(["locked"]);
    expect(await submit(freshId("ghost"), "x")).toEqual(["missing"]);
    const id = freshId("dry-story");
    await seed(id, "flag{x}", 5);
    expect(await submit(id, "flag{x}", { prereq: freshId("p"), teamSolveKeys: [K.solves], dry: true })).toEqual(["correct", "5", "dry"]);
  });
});
