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
//
// #192 adds the other accepted flags (KEYS[9], whole-value membership) and
// the regex-pattern verdict (ARGV[11..13], bound to KEYS[10] by SHA-1 and
// case mode). Those tests pin what the mocked suite cannot: that cjson really
// decodes the stored array, that redis.sha1hex agrees with Node's SHA-1 over
// the same stored string, that a stale or unbound verdict writes nothing, and
// that the story-lock loop never reads the two new hashes as solves.

import { createHash } from "node:crypto";
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
    flagaltsnorm: liveKey("classic", "flagaltsnorm"),
    flagpatterns: liveKey("classic", "flagpatterns"),
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
  async function seed(
    id: string,
    flag: string,
    points: number,
    caseSensitive?: true,
    { alternateFlags = [] as string[], patterns = null as string | null } = {},
  ) {
    await load();
    const record = caseSensitive ? { id, title: id, points, caseSensitive } : { id, title: id, points };
    const forms = [...new Set(alternateFlags.map((f) => keys.flagComparisonForm(f, caseSensitive)))];
    await pipeline([
      ["HSET", K.flagnorm, id, keys.flagComparisonForm(flag, caseSensitive)],
      ["HSET", K.challenges, id, JSON.stringify(record)],
      // #192, written the way upsertChallenge writes them: the comparison
      // forms as a JSON array, the patterns as authored.
      ...(forms.length ? [["HSET", K.flagaltsnorm, id, JSON.stringify(forms)]] : []),
      ...(patterns !== null ? [["HSET", K.flagpatterns, id, patterns]] : []),
    ]);
  }

  const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

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
      // #602: pairs of (solves hash, user record), viewer first, and the
      // viewer's team slug ("" for a team of one) — what teamLockKeys hands in.
      lockKeys = [] as string[],
      team = "",
      // #192: the pattern verdict as submitFlag hands it in — '1'/'0', the
      // SHA-1 of the stored patterns it matched, and the case mode it used.
      verdict = ["0", "", "0"] as [string, string, string],
    } = {},
  ) {
    await load();
    return upstashEval(
      script,
      [
        K.attempts,
        K.solves,
        K.flagnorm,
        K.challenges,
        K.points,
        K.solvecount,
        K.solved,
        K.lastAt,
        K.flagaltsnorm, // KEYS[9]
        K.flagpatterns, // KEYS[10]
        ...lockKeys,
      ],
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
        team, // ARGV[10] — #602 the viewer's team slug ("" = team of one)
        ...verdict, // ARGV[11..13] — #192 the pattern verdict and its binding
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
    const me = liveKey("classic", freshId("user-me"));
    const teammate = liveKey("classic", freshId("solves-bob"));
    const bob = liveKey("classic", freshId("user-bob"));
    await pipeline([
      ["HSET", me, "team", "t", "joinedAt", iso(T0 - 3_600_000)],
      ["HSET", bob, "team", "t", "joinedAt", iso(T0 - 3_600_000)],
    ]);
    const lock = { prereq: prereqId, team: "t", lockKeys: [K.solves, me, teammate, bob] };
    const before = await snapshot();
    expect(await submit(id, "flag{web}", lock)).toEqual(["locked"]);
    expect(await snapshot()).toEqual(before);

    // A NON-teammate's solve does not count — only the keys the caller hands in.
    const stranger = liveKey("classic", freshId("solves-eve"));
    await pipeline([["HSET", stranger, prereqId, `{"points":1,"at":"${iso(T0)}"}`]]);
    expect(await submit(id, "flag{web}", lock)).toEqual(["locked"]);

    // The teammate solves the prerequisite: the same flag now grades.
    await pipeline([["HSET", teammate, prereqId, `{"points":10,"at":"${iso(T0 - 60_000)}"}`]]);
    expect(await submit(id, "flag{web}", lock)).toEqual(["correct", "40"]);
    await pipeline([["DEL", teammate, stranger, me, bob]]);
  });

  // #602: X solved the prerequisite on team A, then left and joined team B.
  // Membership is read NOW, so X's solves hash is among B's lock keys — but
  // the solve is older than X's joinedAt on B, so it opens nothing for B.
  it("story lock: a solve carried in from another team does not open the step (#602)", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(id, "flag{web}", 40);
    const me = liveKey("classic", freshId("user-me"));
    const xSolves = liveKey("classic", freshId("solves-x"));
    const x = liveKey("classic", freshId("user-x"));
    await pipeline([
      ["HSET", me, "team", "b", "joinedAt", iso(T0 - 7_200_000)],
      ["HSET", xSolves, prereqId, `{"points":10,"at":"${iso(T0 - 3_600_000)}"}`],
      ["HSET", x, "team", "b", "joinedAt", iso(T0 - 1_800_000)],
    ]);
    const lock = { prereq: prereqId, team: "b", lockKeys: [K.solves, me, xSolves, x] };
    const before = await snapshot();
    expect(await submit(id, "flag{web}", lock)).toEqual(["locked"]);
    expect(await snapshot()).toEqual(before);

    // Joined before solving: the same solve opens it.
    await pipeline([["HSET", x, "joinedAt", iso(T0 - 5_400_000)]]);
    expect(await submit(id, "flag{web}", lock)).toEqual(["correct", "40"]);
    await pipeline([["DEL", me, xSolves, x]]);
  });

  it("story lock: a member whose record names another team, or no join time, opens nothing (#602)", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(id, "flag{web}", 40);
    const me = liveKey("classic", freshId("user-me"));
    const xSolves = liveKey("classic", freshId("solves-x"));
    const x = liveKey("classic", freshId("user-x"));
    await pipeline([
      ["HSET", me, "team", "b", "joinedAt", iso(T0 - 7_200_000)],
      ["HSET", xSolves, prereqId, `{"points":10,"at":"${iso(T0 - 60_000)}"}`],
      ["HSET", x, "team", "a", "joinedAt", iso(T0 - 7_200_000)],
    ]);
    const lock = { prereq: prereqId, team: "b", lockKeys: [K.solves, me, xSolves, x] };
    expect(await submit(id, "flag{web}", lock)).toEqual(["locked"]);
    await pipeline([["HSET", x, "team", "b"], ["HDEL", x, "joinedAt"]]);
    expect(await submit(id, "flag{web}", lock)).toEqual(["locked"]);
    await pipeline([["DEL", me, xSolves, x]]);
  });

  // ADR 60 (#602): only the current stint's joinedAt is kept, so leaving and
  // rejoining the SAME team re-locks the steps that player's earlier solves
  // had opened. Pinned so a change to it is a decision, not a drift.
  it("story lock: a member who left and rejoined the same team no longer opens with a first-stint solve", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(id, "flag{web}", 40);
    const me = liveKey("classic", freshId("user-me"));
    const xSolves = liveKey("classic", freshId("solves-x"));
    const x = liveKey("classic", freshId("user-x"));
    await pipeline([
      ["HSET", me, "team", "t", "joinedAt", iso(T0 - 7_200_000)],
      ["HSET", xSolves, prereqId, `{"points":10,"at":"${iso(T0 - 3_600_000)}"}`],
      // Rejoined t after that solve: the stint the solve was made in is gone.
      ["HSET", x, "team", "t", "joinedAt", iso(T0 - 600_000)],
    ]);
    expect(await submit(id, "flag{web}", { prereq: prereqId, team: "t", lockKeys: [K.solves, me, xSolves, x] })).toEqual(["locked"]);
    await pipeline([["DEL", me, xSolves, x]]);
  });

  it("story lock: a team of one opens the step with their own solve", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(id, "flag{web}", 40);
    const me = liveKey("classic", freshId("user-solo"));
    await pipeline([["HSET", K.solves, prereqId, `{"points":10,"at":"${iso(T0 - 60_000)}"}`]]);
    expect(await submit(id, "flag{web}", { prereq: prereqId, team: "", lockKeys: [K.solves, me] })).toEqual(["correct", "40"]);
    await pipeline([["HDEL", K.solves, prereqId]]);
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
    expect(await submit(id, "flag{web}", { prereq: prereqId, lockKeys: [K.solves, liveKey("classic", "user-none")] })).toEqual(["locked"]);
    await pipeline([["HDEL", K.lastAt, prereqId]]);
  });

  // CodeRabbit #470 (secrecy boundary): the lock is checked BEFORE the
  // script reads the flag hash — observable as a locked id with no flag at
  // all answering `locked`, not `missing` (both reach a contestant as the
  // same 404). Without a prerequisite, an unknown id is still `missing`.
  it("story lock: checked before any flag read; a dry-run preview skips the lock", async () => {
    expect(await submit(freshId("ghost"), "x", { prereq: "p", lockKeys: [K.solves, liveKey("classic", "user-none")] })).toEqual(["locked"]);
    expect(await submit(freshId("ghost"), "x")).toEqual(["missing"]);
    const id = freshId("dry-story");
    await seed(id, "flag{x}", 5);
    expect(await submit(id, "flag{x}", { prereq: freshId("p"), lockKeys: [K.solves, liveKey("classic", "user-none")], dry: true })).toEqual(["correct", "5", "dry"]);
  });
  // #192 — other accepted flags.
  it("accepts any other accepted flag as ONE solve at full points, counted once", async () => {
    const id = freshId("alts");
    await seed(id, "flag{main}", 30, undefined, { alternateFlags: ["flag{other}", "FLAG{Third}"] });
    expect(await submit(id, "  FLAG{OTHER} ")).toEqual(["correct", "30"]);
    expect(await hget(K.solvecount, id)).toBe("1");
    expect(await hget(K.points, LOGIN)).toBe("30");
    // The primary, or another alternate, after that is the same solve.
    expect(await submit(id, "flag{main}", { nowMs: T0 + 60_000 })).toEqual(["already"]);
    expect(await submit(id, "flag{third}", { nowMs: T0 + 120_000 })).toEqual(["already"]);
    expect(await hget(K.solvecount, id)).toBe("1");
    expect(await hget(K.points, LOGIN)).toBe("30");
  });

  it("still refuses a flag that is none of them, and spends an attempt for it", async () => {
    const id = freshId("alts-miss");
    await seed(id, "flag{main}", 30, undefined, { alternateFlags: ["flag{other}"] });
    expect(await submit(id, "flag{neither}")).toEqual(["incorrect", "1"]);
    expect(await hget(K.solves, id)).toBeNull();
  });

  it("compares the other flags in the challenge's case mode, as whole values", async () => {
    const id = freshId("alts-case");
    await seed(id, "Main{X}", 12, true, { alternateFlags: ["Other{Y}"] });
    expect(await submit(id, "other{y}")).toEqual(["incorrect", "1"]);
    expect(await submit(id, "Other{Y}", { nowMs: T0 + 10_000 })).toEqual(["correct", "12"]);
    // A prefix of an accepted flag is not the flag.
    const loose = freshId("alts-prefix");
    await seed(loose, "flag{main}", 5, undefined, { alternateFlags: ["flag{other}"] });
    expect(await submit(loose, "flag{oth")).toEqual(["incorrect", "1"]);
  });

  it("a corrupt other-flags row accepts nothing and does not break the primary flag", async () => {
    const id = freshId("alts-corrupt");
    await seed(id, "flag{main}", 9);
    await pipeline([["HSET", K.flagaltsnorm, id, "{not json"]]);
    expect(await submit(id, "{not json")).toEqual(["incorrect", "1"]);
    expect(await submit(id, "flag{main}", { nowMs: T0 + 10_000 })).toEqual(["correct", "9"]);
  });

  // #192 — the pattern verdict.
  it("honours a pattern verdict bound to the stored patterns' digest and the case mode", async () => {
    const id = freshId("pat");
    const patterns = JSON.stringify(["[0-9a-f]{8}"]);
    await seed(id, "flag{main}", 20, undefined, { patterns });
    expect(await submit(id, "deadbeef", { verdict: ["1", sha1(patterns), "0"] })).toEqual(["correct", "20"]);
    expect(await hget(K.solvecount, id)).toBe("1");
  });

  it("agrees with Node's SHA-1 over a non-ASCII stored value — the two hashes must see the same bytes", async () => {
    const id = freshId("pat-utf8");
    const patterns = JSON.stringify(["caf\u00e9-[0-9]{2}"]);
    await seed(id, "flag{main}", 4, undefined, { patterns });
    expect(await submit(id, "caf\u00e9-12", { verdict: ["1", sha1(patterns), "0"] })).toEqual(["correct", "4"]);
  });

  it("refuses a verdict as `stale`, writing nothing, when the patterns changed or are gone", async () => {
    const id = freshId("pat-stale");
    const patterns = JSON.stringify(["[0-9]{4}"]);
    await seed(id, "flag{main}", 20, undefined, { patterns });
    const before = await snapshot();
    // Computed against an older value.
    expect(await submit(id, "1234", { verdict: ["1", sha1(JSON.stringify(["[0-9]{3}"])), "0"] })).toEqual(["stale"]);
    // Computed in the other case mode.
    expect(await submit(id, "1234", { verdict: ["1", sha1(patterns), "1"] })).toEqual(["stale"]);
    expect(await snapshot()).toEqual(before);
    expect(await hget(K.attempts, id)).toBeNull();

    // A challenge with no patterns at all: a verdict cannot stand for patterns
    // that are not there, whatever digest it carries.
    const bare = freshId("pat-none");
    await seed(bare, "flag{main}", 20);
    expect(await submit(bare, "1234", { verdict: ["1", sha1(""), "0"] })).toEqual(["stale"]);
    expect(await hget(K.attempts, bare)).toBeNull();
  });

  it("checks the guards before the verdict: already, cooldown and the story lock still answer first", async () => {
    const id = freshId("pat-guards");
    const patterns = JSON.stringify(["[0-9]{4}"]);
    await seed(id, "flag{main}", 20, undefined, { patterns });
    const ok: [string, string, string] = ["1", sha1(patterns), "0"];
    expect(await submit(id, "nope", { nowMs: T0, cooldownMs: 5_000 })).toEqual(["incorrect", "1"]);
    expect(await submit(id, "1234", { nowMs: T0 + 1, cooldownMs: 5_000, verdict: ok })).toEqual(["cooldown", String(T0 + 5_000)]);
    expect(await submit(id, "1234", { nowMs: T0 + 1, cooldownMs: 5_000, verdict: ok, prereq: freshId("p"), lockKeys: [K.solves, liveKey("classic", "user-none")] })).toEqual(["locked"]);
    expect(await submit(id, "1234", { nowMs: T0 + 5_000, cooldownMs: 5_000, verdict: ok })).toEqual(["correct", "20"]);
    expect(await submit(id, "1234", { nowMs: T0 + 9_000, cooldownMs: 5_000, verdict: ok })).toEqual(["already"]);
  });

  it("a verdict of 0 adds nothing: a non-matching submission is incorrect", async () => {
    const id = freshId("pat-zero");
    await seed(id, "flag{main}", 20, undefined, { patterns: JSON.stringify(["[0-9]{4}"]) });
    expect(await submit(id, "12345")).toEqual(["incorrect", "1"]);
  });

  it("dry run: a pattern verdict grades correct and writes nothing", async () => {
    const id = freshId("pat-dry");
    const patterns = JSON.stringify(["[0-9]{4}"]);
    await seed(id, "flag{main}", 20, undefined, { patterns });
    const before = await snapshot();
    expect(await submit(id, "1234", { dry: true, verdict: ["1", sha1(patterns), "0"] })).toEqual(["correct", "20", "dry"]);
    expect(await snapshot()).toEqual(before);
  });

  // KEYS[9] holds a field per challenge with other flags — including, often,
  // the PREREQUISITE. If the lock loop started at 9 it would read that hash as
  // a solves hash, find the prerequisite's field, then HMGET the patterns hash
  // as a user record (no team) and open the step for a team of one.
  it("story lock: the other-flags and patterns hashes are never read as a teammate's solves", async () => {
    const prereqId = freshId("recon");
    const id = freshId("web");
    await seed(prereqId, "flag{recon}", 10, undefined, { alternateFlags: ["flag{recon2}"], patterns: JSON.stringify(["r[0-9]{2}"]) });
    await seed(id, "flag{web}", 40);
    expect(await submit(id, "flag{web}", { prereq: prereqId, team: "", lockKeys: [K.solves, liveKey("classic", "user-none")] })).toEqual(["locked"]);
  });
});
