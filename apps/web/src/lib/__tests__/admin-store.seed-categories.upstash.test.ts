// Integration tests: runs the REAL SEED_CATEGORIES_SCRIPT against a live Redis
// (srh in CI, Upstash or srh locally). The union that issue #344 turns on is
// Lua now, and Lua is only really pinned by executing it — the mocked seed
// suite next door can prove which arguments the script is handed, never what
// it does with them. Gating comes from live-redis.ts: skipped without the env,
// a FAILURE when CTF_LUA_SUITES_REQUIRED is set.
//
// Key-isolated, unlike the admin-store settings suite: every key here carries a
// per-run suffix, so this file is safe beside the fixed-key suites in the
// serial live run.
//
// What the script has to get right, and why each is here:
//
//   - the organizer's categories SURVIVE a seed (the whole of #344),
//   - in THEIR order, because that is the order the board renders headings in,
//   - deduped case-insensitively, since the board's filter is exact equality
//     and two casings would split challenges across two headings,
//   - with every seeded challenge rewritten to the spelling the union KEPT —
//     the half that a surviving list alone does not cover, because a row under
//     a spelling absent from the list is exactly as invisible as before,
//   - and refusing, writing NOTHING, rather than storing a list over the cap.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));

const SUFFIX = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
const CATS = `ctf:test:${SUFFIX}:categories`;
const ITEMS = `ctf:test:${SUFFIX}:challenges`;

const MAX = 50;

/** A public challenge record in the shape the seed builds — no flag, ever. */
const record = (id: string, category: string) => ({ id, title: id, category, description: "", points: 100, order: 1 });

describe.skipIf(!liveConfigured)("SEED_CATEGORIES_SCRIPT against a live SRH proxy", () => {
  let SEED_CATEGORIES_SCRIPT: string;
  let upstashPipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  beforeAll(async () => {
    ({ SEED_CATEGORIES_SCRIPT } = await import("@/lib/admin-store"));
    ({ upstashPipeline } = await import("@/lib/upstash"));
  });

  beforeEach(async () => {
    await upstashPipeline([["DEL", CATS], ["DEL", ITEMS]]);
  });

  afterAll(async () => {
    await upstashPipeline([["DEL", CATS], ["DEL", ITEMS]]);
  });

  /** Runs the script exactly as `seedCategoriesAndChallenges` queues it. */
  async function seed(fixture: string[], records: ReturnType<typeof record>[], max = MAX) {
    const [res] = await upstashPipeline([
      ["EVAL", SEED_CATEGORIES_SCRIPT, 2, CATS, ITEMS, JSON.stringify(fixture), max, ...records.map((r) => JSON.stringify(r))],
    ]);
    return res;
  }

  /** The stored category list, parsed. */
  async function storedCategories(): Promise<unknown> {
    const [res] = await upstashPipeline([["GET", CATS]]);
    return typeof res.result === "string" ? JSON.parse(res.result) : res.result;
  }

  /** Every stored challenge record, by id. */
  async function storedRecords(): Promise<Record<string, { category: string; points: number }>> {
    const [res] = await upstashPipeline([["HGETALL", ITEMS]]);
    const flat = (res.result ?? []) as unknown;
    const out: Record<string, { category: string; points: number }> = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = JSON.parse(String(flat[i + 1]));
    } else if (flat && typeof flat === "object") {
      // srh can answer HGETALL as an object rather than a flat array.
      for (const [k, v] of Object.entries(flat as Record<string, string>)) out[k] = JSON.parse(v);
    }
    return out;
  }

  it("writes the fixture's list when the board has none yet", async () => {
    await seed(["Web", "Crypto"], [record("a", "Web")]);
    expect(await storedCategories()).toEqual(["Web", "Crypto"]);
    // A JSON ARRAY, not cjson's empty-table-as-object — everything that reads
    // this key parses it as an array.
    const [raw] = await upstashPipeline([["GET", CATS]]);
    expect(String(raw.result).startsWith("[")).toBe(true);
  });

  it("KEEPS the organizer's categories and appends the fixture's after them", async () => {
    // Issue #344 itself: before the fix this SET the list to ["Web","Crypto"]
    // and took Pwn and Misc — and every challenge in them — off the board.
    await upstashPipeline([["SET", CATS, JSON.stringify(["Pwn", "Misc"])]]);
    await seed(["Web", "Crypto"], [record("a", "Web")]);
    expect(await storedCategories()).toEqual(["Pwn", "Misc", "Web", "Crypto"]);
  });

  it("does not duplicate a category the organizer already has, whatever its casing", async () => {
    await upstashPipeline([["SET", CATS, JSON.stringify(["web", "Pwn"])]]);
    await seed(["Web", "Crypto"], [record("a", "Web")]);
    // Their spelling wins and stays put: renaming "web" to the fixture's "Web"
    // would hide THEIR challenges instead of ours.
    expect(await storedCategories()).toEqual(["web", "Pwn", "Crypto"]);
  });

  it("rewrites each seeded challenge to the spelling the union kept", async () => {
    await upstashPipeline([["SET", CATS, JSON.stringify(["pwn"])]]);
    await seed(["Pwn"], [record("a", "Pwn"), record("b", "Pwn")]);

    const cats = (await storedCategories()) as string[];
    const rows = await storedRecords();
    expect(cats).toEqual(["pwn"]);
    // The half a surviving list alone would not fix: stored under "Pwn" against
    // a list holding only "pwn", these rows would be invisible to the board's
    // exact-match filter — the same outcome #344 is about.
    for (const id of ["a", "b"]) expect(rows[id].category, id).toBe("pwn");
    for (const row of Object.values(rows)) expect(cats).toContain(row.category);
  });

  it("leaves a challenge's other fields intact through the rewrite", async () => {
    await seed(["Web"], [record("a", "Web")]);
    const rows = await storedRecords();
    // Re-encoding must not turn 100 into "100" or drop a field.
    expect(rows.a).toEqual({ id: "a", title: "a", category: "Web", description: "", points: 100, order: 1 });
  });

  it("carries no flag into the public record, whatever the caller passed", async () => {
    // The secrecy boundary the seed keeps by building records field by field.
    await seed(["Web"], [record("a", "Web")]);
    const [res] = await upstashPipeline([["HGET", ITEMS, "a"]]);
    expect(String(res.result)).not.toMatch(/flag/i);
  });

  it("treats an unparseable stored value as an empty list rather than failing", async () => {
    await upstashPipeline([["SET", CATS, "not json at all"]]);
    await seed(["Web"], [record("a", "Web")]);
    expect(await storedCategories()).toEqual(["Web"]);
  });

  it("REFUSES an over-cap union and writes nothing at all", async () => {
    const existing = Array.from({ length: 48 }, (_, i) => `Cat ${i}`);
    await upstashPipeline([["SET", CATS, JSON.stringify(existing)]]);

    const res = await seed(["Web", "Crypto", "Forensics", "Recon"], [record("a", "Web")], MAX);
    expect(res.error, "the script must refuse, not trim").toBeTruthy();
    expect(String(res.error)).toMatch(/over the limit of 50/);

    // Nothing written: the list is untouched and no challenge landed. Trimming
    // the overflow would orphan the rows naming those categories, and storing
    // an over-cap list would make every later category edit fail validation.
    expect(await storedCategories()).toEqual(existing);
    expect(await storedRecords()).toEqual({});
  });

  it("is idempotent — a second seed changes nothing", async () => {
    await upstashPipeline([["SET", CATS, JSON.stringify(["Pwn"])]]);
    await seed(["Web"], [record("a", "Web")]);
    const first = await storedCategories();
    await seed(["Web"], [record("a", "Web")]);
    expect(await storedCategories()).toEqual(first);
  });

  it("picks up a category added AFTER the caller built the command", async () => {
    // The race CodeRabbit flagged on the read-then-write version: with a GET
    // here and a SET later, an organizer's edit landing in between was read as
    // absent and overwritten. The read happens inside the script now, so an
    // edit that lands before it runs is part of the union rather than a
    // casualty of it.
    const cmd: (string | number)[] = [
      "EVAL", SEED_CATEGORIES_SCRIPT, 2, CATS, ITEMS, JSON.stringify(["Web"]), MAX, JSON.stringify(record("a", "Web")),
    ];
    await upstashPipeline([["SET", CATS, JSON.stringify(["Pwn"])]]);
    await upstashPipeline([cmd]);
    expect(await storedCategories()).toEqual(["Pwn", "Web"]);
  });
});
