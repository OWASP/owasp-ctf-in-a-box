// Executes ai's AWARD_SCRIPT — the module's grading authority, and until this
// suite the only one of the three never run by any test — against a real
// Redis via SRH, on run-unique keys. See live-redis.ts for the harness.
//
// Two paths share the script: ARGV[8] = "1" grades a typed flag exactly like
// classic; ARGV[8] = "0" records a solve the external site asserted through a
// signed event, with no flag comparison and no attempts row. The script's own
// refusals — a signed event against a `mode: "flag"` challenge, a re-solve —
// are what this suite pins.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attemptsRow, freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe.skipIf(!liveConfigured)("ai AWARD_SCRIPT against a live Redis", () => {
  const K = {
    attempts: liveKey("ai", "attempts"),
    solves: liveKey("ai", "solves"),
    flagnorm: liveKey("ai", "flagnorm"),
    challenges: liveKey("ai", "challenges"),
    points: liveKey("ai", "points"),
    solvecount: liveKey("ai", "solvecount"),
    solved: liveKey("ai", "solved"),
  };
  // Per test, so no total asserted here can be inflated by an earlier test.
  let LOGIN = "";
  beforeEach(() => {
    LOGIN = freshId("mona");
  });

  let script: string;
  let upstashEval: (typeof import("@/lib/upstash"))["upstashEval"];
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];
  let keys: typeof import("@/lib/classic-keys");

  async function load() {
    if (script) return;
    ({ AWARD_SCRIPT: script } = await import("@/lib/ai-store"));
    ({ upstashEval, upstashPipeline: pipeline } = await import("@/lib/upstash"));
    keys = await import("@/lib/classic-keys");
  }

  afterAll(async () => {
    if (pipeline) await pipeline([["DEL", ...Object.values(K)]]);
  });

  /** Seeds a challenge the way the ai authoring path does: the record (with
   *  its `mode`) into challenges, and — only when a flag exists — its
   *  comparison form into flagnorm. */
  async function seed(id: string, mode: "flag" | "event" | "both", points: number, flag?: string, caseSensitive?: true) {
    await load();
    const record: Record<string, unknown> = { id, title: id, mode, points };
    if (caseSensitive) record.caseSensitive = true;
    const cmds: (string | number)[][] = [["HSET", K.challenges, id, JSON.stringify(record)]];
    if (flag !== undefined) cmds.push(["HSET", K.flagnorm, id, keys.flagComparisonForm(flag, caseSensitive)]);
    await pipeline(cmds);
  }

  const KEYS = () => [K.attempts, K.solves, K.flagnorm, K.challenges, K.points, K.solvecount, K.solved];

  /** The typed-flag path (`submitAiFlag` → runAward with grade=true). */
  async function submitFlag(id: string, flag: string, { nowMs = T0, cooldownMs = 5_000, login = LOGIN, dry = false } = {}) {
    await load();
    return upstashEval(script, KEYS(), [
      id,
      keys.normalizeFlag(flag),
      iso(nowMs),
      login,
      cooldownMs,
      nowMs,
      keys.caseSensitiveFlagForm(flag),
      "1",
      "flag",
      dry ? "1" : "0", // ARGV[10] — #464 admin preview dry run
    ]);
  }

  /** Every key the script can touch, as sorted field maps (HGETALL's field
   *  ORDER is not stable across a hash's re-encoding, only its contents). */
  async function snapshot() {
    await load();
    const replies = await pipeline(KEYS().map((k) => ["HGETALL", k]));
    return replies.map(({ result }) => {
      const flat = (result as string[] | null) ?? [];
      const pairs: [string, string][] = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
      return Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)));
    });
  }

  /** The signed-event path (`recordAiEvent` → runAward with grade=false). */
  async function recordEvent(id: string, { nowMs = T0, login = LOGIN } = {}) {
    await load();
    return upstashEval(script, KEYS(), [id, "", iso(nowMs), login, 5_000, nowMs, "", "0", "event"]);
  }

  async function hget(key: string, field: string) {
    const [r] = await pipeline([["HGET", key, field]]);
    return r.result;
  }

  it("returns missing for an unknown challenge on both paths", async () => {
    const id = freshId("ghost");
    expect(await submitFlag(id, "x")).toEqual(["missing"]);
    expect(await recordEvent(id)).toEqual(["missing"]);
  });

  it("flag path: grades a first-ever wrong flag with a cooldown set, then awards the right one with source=flag", async () => {
    const id = freshId("chal");
    await seed(id, "both", 40, "flag{ai}");
    expect(await submitFlag(id, "flag{nope}")).toEqual(["incorrect", "1"]);
    expect(await hget(K.attempts, id)).toBe(attemptsRow(1, iso(T0), iso(T0), T0));
    expect(await submitFlag(id, "FLAG{AI}", { nowMs: T0 + 5_000 })).toEqual(["correct", "40"]);
    expect(await hget(K.solves, id)).toBe(`{"points":40,"at":"${iso(T0 + 5_000)}","source":"flag"}`);
    expect(await hget(K.points, LOGIN)).toBe("40");
    expect(await hget(K.solved, LOGIN)).toBe("1");
    expect(await hget(K.solvecount, id)).toBe("1");
    expect(await hget(K.solvecount, LOGIN)).toBeNull();
  });

  it("flag path: enforces the cooldown from the row it reads, and the case-sensitive form when marked", async () => {
    const id = freshId("chal");
    await seed(id, "flag", 9, "Ai{Strict}", true);
    expect(await submitFlag(id, "ai{strict}", { nowMs: T0 })).toEqual(["incorrect", "1"]);
    expect(await submitFlag(id, "Ai{Strict}", { nowMs: T0 + 4_999 })).toEqual(["cooldown", String(T0 + 5_000)]);
    expect(await submitFlag(id, "Ai{Strict}", { nowMs: T0 + 5_000 })).toEqual(["correct", "9"]);
  });

  it("event path: refuses a `mode: flag` challenge with `mode`, writing nothing", async () => {
    // The route also checks this; the script refuses on its own so a route
    // that forgets cannot bank an event-asserted solve on a typed-flag challenge.
    const id = freshId("flagonly");
    await seed(id, "flag", 15, "flag{typed}");
    expect(await recordEvent(id)).toEqual(["mode"]);
    expect(await hget(K.solves, id)).toBeNull();
    expect(await hget(K.points, LOGIN)).toBeNull();
  });

  it("event path: awards an event-mode challenge with no flag and no attempts row, source=event", async () => {
    const id = freshId("evt");
    await seed(id, "event", 30); // no flagnorm entry at all
    expect(await recordEvent(id)).toEqual(["correct", "30"]);
    expect(await hget(K.solves, id)).toBe(`{"points":30,"at":"${iso(T0)}","source":"event"}`);
    expect(await hget(K.attempts, id)).toBeNull();
    expect(await hget(K.points, LOGIN)).toBe("30");
    expect(await hget(K.solvecount, id)).toBe("1");
  });

  it("refuses to re-award on either path once solved: `already`, counters unchanged", async () => {
    const id = freshId("both");
    await seed(id, "both", 12, "flag{both}");
    expect(await recordEvent(id)).toEqual(["correct", "12"]);
    const before = await pipeline([["HGET", K.points, LOGIN], ["HGET", K.solved, LOGIN], ["HGET", K.solvecount, id]]);
    expect(await recordEvent(id, { nowMs: T0 + 1 })).toEqual(["already"]);
    expect(await submitFlag(id, "flag{both}", { nowMs: T0 + 2 })).toEqual(["already"]);
    expect(await pipeline([["HGET", K.points, LOGIN], ["HGET", K.solved, LOGIN], ["HGET", K.solvecount, id]])).toEqual(before);
    expect(await hget(K.attempts, id)).toBeNull();
  });

  // #464 admin preview: the flag path's SAME script grades and writes nothing.
  it("dry run (flag path): grades right and wrong flags and writes nothing at all", async () => {
    const id = freshId("dry");
    await seed(id, "flag", 30, "ctf{right}");
    const before = await snapshot();
    expect(await submitFlag(id, "ctf{right}", { dry: true })).toEqual(["correct", "30", "dry"]);
    expect(await submitFlag(id, "ctf{nope}", { dry: true })).toEqual(["incorrect", "0", "dry"]);
    expect(await snapshot()).toEqual(before);
  });

  it("dry run (flag path): ignores the cooldown, still refuses unknown and already-solved", async () => {
    const id = freshId("dry-guards");
    expect(await submitFlag(id, "x", { dry: true })).toEqual(["missing"]);
    await seed(id, "flag", 30, "ctf{right}");
    expect(await submitFlag(id, "ctf{nope}", { cooldownMs: 60_000 })).toEqual(["incorrect", "1"]);
    expect(await submitFlag(id, "ctf{right}", { nowMs: T0 + 1, cooldownMs: 60_000, dry: true })).toEqual(["correct", "30", "dry"]);
    expect(await submitFlag(id, "ctf{right}", { nowMs: T0 + 120_000 })).toEqual(["correct", "30"]);
    expect(await submitFlag(id, "ctf{right}", { nowMs: T0 + 130_000, dry: true })).toEqual(["already"]);
  });

  it("anti-vacuous: the SAME flag without dry run does write", async () => {
    const id = freshId("dry-anti");
    await seed(id, "flag", 30, "ctf{right}");
    const before = await snapshot();
    expect(await submitFlag(id, "ctf{right}")).toEqual(["correct", "30"]);
    expect(await snapshot()).not.toEqual(before);
  });
});
