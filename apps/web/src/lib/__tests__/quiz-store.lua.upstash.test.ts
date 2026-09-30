// Executes quiz's GRADE_SCRIPT — the grading authority — against a real
// Redis via SRH. The mocked grade suite pins what `answerQuestion` hands the
// script; this one pins what the script does with it, on run-unique keys.
// See live-redis.ts for the harness and classic-store.lua.upstash.test.ts
// for the sibling.
//
// The assertion this suite exists for is the attempt cap: the JS pre-check
// enforces `>=` too, so flipping the Lua's comparison to `>` (one free
// attempt per question) survives every mocked test. Here the script is the
// only thing between a seeded at-cap row and an award.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attemptsRow, freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
// The store canonicalizes choices as a sorted, deduplicated JSON array
// (`canonicalizeChoices`); the script compares that string exactly.
const CORRECT = JSON.stringify(["a", "c"]);
const WRONG = JSON.stringify(["a"]);

describe.skipIf(!liveConfigured)("quiz GRADE_SCRIPT against a live Redis", () => {
  const K = {
    attempts: liveKey("quiz", "attempts"),
    answers: liveKey("quiz", "answers"),
    key: liveKey("quiz", "key"),
    questions: liveKey("quiz", "questions"),
    points: liveKey("quiz", "points"),
    answered: liveKey("quiz", "answered"),
    lastAt: liveKey("quiz", "lastAt"),
  };
  // Per test, so no total asserted here can be inflated by an earlier test.
  let LOGIN = "";
  beforeEach(() => {
    LOGIN = freshId("octocat");
  });

  let script: string;
  let upstashEval: (typeof import("@/lib/upstash"))["upstashEval"];
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  async function load() {
    if (script) return;
    ({ GRADE_SCRIPT: script } = await import("@/lib/quiz-store"));
    ({ upstashEval, upstashPipeline: pipeline } = await import("@/lib/upstash"));
  }

  afterAll(async () => {
    if (pipeline) await pipeline([["DEL", ...Object.values(K)]]);
  });

  async function seed(id: string, points: number) {
    await load();
    await pipeline([
      ["HSET", K.key, id, CORRECT],
      ["HSET", K.questions, id, JSON.stringify({ id, prompt: id, points })],
    ]);
  }

  async function answer(
    id: string,
    submitted: string,
    { nowMs = T0, maxAttempts = 3, cooldownMs = 0, login = LOGIN, dry = false } = {},
  ) {
    await load();
    return upstashEval(
      script,
      [K.attempts, K.answers, K.key, K.questions, K.points, K.answered, K.lastAt],
      [id, submitted, iso(nowMs), login, maxAttempts, cooldownMs, nowMs, dry ? "1" : "0"],
    );
  }

  /** Every key the script can touch, as sorted field maps (HGETALL's field
   *  ORDER is not stable across a hash's re-encoding, only its contents). */
  async function snapshot() {
    await load();
    const replies = await pipeline(Object.values(K).map((k) => ["HGETALL", k]));
    return replies.map(({ result }) => {
      const flat = (result as string[] | null) ?? [];
      const pairs: [string, string][] = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
      return Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)));
    });
  }

  async function hget(key: string, field: string) {
    const [r] = await pipeline([["HGET", key, field]]);
    return r.result;
  }

  it("returns missing for an unknown question", async () => {
    expect(await answer(freshId("ghost"), CORRECT)).toEqual(["missing"]);
  });

  it("awards a correct answer once: answer row with the choices, login totals", async () => {
    const id = freshId("q");
    await seed(id, 20);
    expect(await answer(id, CORRECT)).toEqual(["correct", "20"]);
    expect(await hget(K.answers, id)).toBe(`{"choices":["a","c"],"points":20,"at":"${iso(T0)}"}`);
    expect(await hget(K.points, LOGIN)).toBe("20");
    expect(await hget(K.answered, LOGIN)).toBe("1");
    expect(await answer(id, CORRECT, { nowMs: T0 + 1 })).toEqual(["already"]);
    expect(await hget(K.points, LOGIN)).toBe("20");
  });

  // #522: the leaderboard's "whoever got there first" tiebreak reads this.
  it("stamps the login's last award time, and only an award moves it", async () => {
    const first = freshId("q");
    const second = freshId("q");
    await seed(first, 20);
    await seed(second, 10);
    expect(await hget(K.lastAt, LOGIN)).toBeNull();
    expect(await answer(first, CORRECT)).toEqual(["correct", "20"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0));
    // A miss, a repeat of a banked answer and a dry-run award leave it alone.
    expect(await answer(second, WRONG, { nowMs: T0 + 1_000 })).toEqual(["incorrect", "1"]);
    expect(await answer(first, CORRECT, { nowMs: T0 + 2_000 })).toEqual(["already"]);
    expect(await answer(second, CORRECT, { nowMs: T0 + 3_000, dry: true })).toEqual(["correct", "10", "dry"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0));
    // The next real award does.
    expect(await answer(second, CORRECT, { nowMs: T0 + 4_000 })).toEqual(["correct", "10"]);
    expect(await hget(K.lastAt, LOGIN)).toBe(iso(T0 + 4_000));
  });

  it("counts a wrong answer as an attempt, including the first-ever one with a cooldown set", async () => {
    const id = freshId("q");
    await seed(id, 20);
    expect(await answer(id, WRONG, { cooldownMs: 60_000 })).toEqual(["incorrect", "1"]);
    expect(await hget(K.attempts, id)).toBe(attemptsRow(1, iso(T0), iso(T0), T0));
  });

  it("exhausts at the cap with `>=`: an at-cap row is refused, one below it is graded", async () => {
    const atCap = freshId("q");
    await seed(atCap, 20);
    await pipeline([["HSET", K.attempts, atCap, attemptsRow(3, iso(T0 - 2), iso(T0 - 1), T0 - 1)]]);
    expect(await answer(atCap, CORRECT, { maxAttempts: 3 })).toEqual(["exhausted"]);
    expect(await hget(K.answers, atCap)).toBeNull();

    const belowCap = freshId("q");
    await seed(belowCap, 20);
    await pipeline([["HSET", K.attempts, belowCap, attemptsRow(2, iso(T0 - 2), iso(T0 - 1), T0 - 1)]]);
    expect(await answer(belowCap, CORRECT, { maxAttempts: 3 })).toEqual(["correct", "20"]);
  });

  it("treats maxAttempts 0 as uncapped", async () => {
    const id = freshId("q");
    await seed(id, 5);
    await pipeline([["HSET", K.attempts, id, attemptsRow(50, iso(T0 - 2), iso(T0 - 1), T0 - 1)]]);
    expect(await answer(id, WRONG, { maxAttempts: 0 })).toEqual(["incorrect", "51"]);
  });

  it("enforces the retry cooldown from the row it reads, refused below the boundary and graded at it", async () => {
    const id = freshId("q");
    await seed(id, 5);
    expect(await answer(id, WRONG, { nowMs: T0, cooldownMs: 300_000 })).toEqual(["incorrect", "1"]);
    expect(await answer(id, WRONG, { nowMs: T0 + 299_999, cooldownMs: 300_000 })).toEqual([
      "cooldown",
      String(T0 + 300_000),
    ]);
    expect(await hget(K.attempts, id)).toBe(attemptsRow(1, iso(T0), iso(T0), T0));
    expect(await answer(id, WRONG, { nowMs: T0 + 300_000, cooldownMs: 300_000 })).toEqual(["incorrect", "2"]);
  });

  // #464 admin preview: the SAME script grades and writes nothing.
  it("dry run: grades a correct answer and writes nothing at all", async () => {
    const id = freshId("dry-ok");
    await seed(id, 20);
    const before = await snapshot();
    expect(await answer(id, CORRECT, { dry: true })).toEqual(["correct", "20", "dry"]);
    expect(await snapshot()).toEqual(before);
  });

  it("dry run: grades a wrong answer without spending an attempt", async () => {
    const id = freshId("dry-wrong");
    await seed(id, 20);
    const before = await snapshot();
    expect(await answer(id, '["z"]', { dry: true })).toEqual(["incorrect", "0", "dry"]);
    expect(await snapshot()).toEqual(before);
  });

  it("dry run: an exhausted attempt budget or a cooldown does not block a preview", async () => {
    const id = freshId("dry-cap");
    await seed(id, 20);
    expect(await answer(id, '["z"]', { maxAttempts: 1, cooldownMs: 60_000 })).toEqual(["incorrect", "1"]);
    expect(await answer(id, CORRECT, { nowMs: T0 + 1, maxAttempts: 1, cooldownMs: 60_000, dry: true })).toEqual(["correct", "20", "dry"]);
  });

  it("anti-vacuous: the SAME answer without dry run does write", async () => {
    const id = freshId("dry-anti");
    await seed(id, 20);
    expect(await answer(id, CORRECT, { dry: true })).toEqual(["correct", "20", "dry"]);
    const before = await snapshot();
    expect(await answer(id, CORRECT)).toEqual(["correct", "20"]);
    expect(await snapshot()).not.toEqual(before);
  });

  it("dry run: still refuses an unknown question and an already-answered one", async () => {
    const id = freshId("dry-guards");
    expect(await answer(id, CORRECT, { dry: true })).toEqual(["missing"]);
    await seed(id, 20);
    expect(await answer(id, CORRECT)).toEqual(["correct", "20"]);
    expect(await answer(id, CORRECT, { nowMs: T0 + 1, dry: true })).toEqual(["already"]);
  });
});
