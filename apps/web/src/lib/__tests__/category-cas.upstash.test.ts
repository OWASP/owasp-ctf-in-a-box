// Integration tests: runs the REAL category write scripts (SET_CATEGORIES_SCRIPT,
// RENAME_CATEGORY_SCRIPT) and the TS halves that drive them against a live
// Redis behind srh. Gating comes from live-redis.ts: skipped without the env, a
// FAILURE when CTF_LUA_SUITES_REQUIRED is set.
//
// What is under test is a race, so every case here builds one on purpose. The
// stores read the list (and, for a rename, the challenge hash), decide in JS,
// and then hand Redis a guarded write. `@/lib/upstash` is wrapped so a test can
// land a second organizer's write in exactly the window that matters — after
// that read, before the EVAL — and then assert nothing either organizer did was
// lost:
//
//   - a whole-list replace refuses (CategoryConflictError) instead of
//     overwriting a concurrent add, and leaves the add in place,
//   - a rename retries against the fresh state, so a concurrent add survives
//     the rename AND the rename still lands,
//   - a challenge filed into the category mid-rename is carried across, not
//     orphaned under a name the list no longer holds,
//   - an edit to a challenge being moved is kept, not overwritten by the
//     rename's copy of it,
//   - a refused script writes NOTHING — neither the list nor any challenge.
//
// Key-isolated: every key carries a per-run suffix, so this file is safe beside
// the fixed-key suites in the serial live run.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

type Pipeline = (typeof import("@/lib/upstash"))["upstashPipeline"];

/** Writes to land between a store's read and its EVAL, one per EVAL, in
 *  order. `real` is the unwrapped pipeline, so a hook's own writes are never
 *  intercepted. */
const race = vi.hoisted(() => ({
  beforeEval: [] as (() => Promise<void>)[],
  everyEval: null as null | (() => Promise<void>),
  evals: 0,
  real: null as unknown as (commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>,
}));

vi.mock("@/lib/upstash", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/upstash")>();
  race.real = (commands) => real.upstashPipeline(commands);
  const wrapped: Pipeline = async (commands, opts) => {
    if (commands[0]?.[0] === "EVAL") {
      race.evals += 1;
      const hook = race.beforeEval.shift() ?? race.everyEval;
      if (hook) await hook();
    }
    return real.upstashPipeline(commands, opts);
  };
  return { ...real, upstashPipeline: wrapped };
});

const CATS = liveKey("category-cas", "categories");
const ITEMS = liveKey("category-cas", "challenges");
const KEYS = { categories: CATS, challenges: ITEMS };

const record = (id: string, category: string, points = 100) => ({
  id,
  title: `T ${id}`,
  category,
  description: "",
  points,
  order: 1,
});

describe.skipIf(!liveConfigured)("category write scripts against a live SRH proxy", () => {
  let mod: typeof import("@/lib/category-cas");

  beforeAll(async () => {
    mod = await import("@/lib/category-cas");
  });

  beforeEach(async () => {
    race.beforeEval = [];
    race.everyEval = null;
    race.evals = 0;
    await race.real([["DEL", CATS], ["DEL", ITEMS]]);
  });

  afterAll(async () => {
    await race.real([["DEL", CATS], ["DEL", ITEMS]]);
  });

  async function setList(names: string[]) {
    await race.real([["SET", CATS, JSON.stringify(names)]]);
  }

  async function putChallenge(r: ReturnType<typeof record>) {
    await race.real([["HSET", ITEMS, r.id, JSON.stringify(r)]]);
  }

  async function storedList(): Promise<unknown> {
    const [res] = await race.real([["GET", CATS]]);
    return typeof res.result === "string" ? JSON.parse(res.result) : res.result;
  }

  async function storedRecords(): Promise<Record<string, ReturnType<typeof record>>> {
    const [res] = await race.real([["HGETALL", ITEMS]]);
    const flat = (res.result ?? []) as unknown;
    const out: Record<string, ReturnType<typeof record>> = {};
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = JSON.parse(String(flat[i + 1]));
    } else if (flat && typeof flat === "object") {
      for (const [k, v] of Object.entries(flat as Record<string, string>)) out[k] = JSON.parse(v);
    }
    return out;
  }

  describe("SET_CATEGORIES_SCRIPT", () => {
    async function run(present: "0" | "1", raw: string, next: string[]) {
      const [res] = await race.real([["EVAL", mod.SET_CATEGORIES_SCRIPT, 1, CATS, present, raw, JSON.stringify(next)]]);
      return res;
    }

    it("writes when the stored value is still the one the caller read", async () => {
      await setList(["Web"]);
      const res = await run("1", JSON.stringify(["Web"]), ["Web", "Crypto"]);
      expect(res.result).toBe(1);
      expect(await storedList()).toEqual(["Web", "Crypto"]);
    });

    it("refuses, writing nothing, when the stored value moved on", async () => {
      await setList(["Web", "Pwn"]);
      const res = await run("1", JSON.stringify(["Web"]), ["Web", "Crypto"]);
      expect(res.result).toBe(0);
      expect(await storedList()).toEqual(["Web", "Pwn"]);
    });

    it("treats an absent key as its own state: a list created meanwhile is not overwritten", async () => {
      await setList(["Pwn"]);
      const res = await run("0", "", ["Web"]);
      expect(res.result).toBe(0);
      expect(await storedList()).toEqual(["Pwn"]);
    });

    it("writes over an absent key when it is still absent", async () => {
      const res = await run("0", "", ["Web"]);
      expect(res.result).toBe(1);
      expect(await storedList()).toEqual(["Web"]);
    });
  });

  describe("writeCategoriesIfUnchanged", () => {
    it("replaces the list when nobody else wrote in between", async () => {
      await setList(["Web"]);
      await mod.writeCategoriesIfUnchanged(CATS, ["Web"], ["Web", "Crypto"]);
      expect(await storedList()).toEqual(["Web", "Crypto"]);
    });

    it("REFUSES rather than overwrite a category another organizer added after the read", async () => {
      // The race itself: organizer A loaded ["Web"] and adds "Crypto"; B's add
      // of "Pwn" lands between A's read and A's write. Last-write-wins would
      // store ["Web","Crypto"] and drop "Pwn" without a word to anyone.
      await setList(["Web"]);
      race.beforeEval.push(() => setList(["Web", "Pwn"]).then(() => undefined));

      await expect(mod.writeCategoriesIfUnchanged(CATS, ["Web"], ["Web", "Crypto"])).rejects.toBeInstanceOf(
        mod.CategoryConflictError,
      );
      expect(await storedList()).toEqual(["Web", "Pwn"]);
    });

    it("refuses outright when the client's view is already stale, without trying the write", async () => {
      await setList(["Web", "Pwn"]);
      await expect(mod.writeCategoriesIfUnchanged(CATS, ["Web"], ["Web", "Crypto"])).rejects.toBeInstanceOf(
        mod.CategoryConflictError,
      );
      expect(race.evals).toBe(0);
      expect(await storedList()).toEqual(["Web", "Pwn"]);
    });

    it("treats a concurrent re-order as an edit too, since order is what the board renders", async () => {
      await setList(["Web", "Pwn"]);
      race.beforeEval.push(() => setList(["Pwn", "Web"]).then(() => undefined));
      await expect(mod.writeCategoriesIfUnchanged(CATS, ["Web", "Pwn"], ["Web", "Pwn", "Misc"])).rejects.toBeInstanceOf(
        mod.CategoryConflictError,
      );
      expect(await storedList()).toEqual(["Pwn", "Web"]);
    });
  });

  describe("RENAME_CATEGORY_SCRIPT", () => {
    it("refuses a stale list guard and writes neither the list nor any challenge", async () => {
      await setList(["Webb", "Pwn"]);
      await putChallenge(record("a", "Webb"));
      const before = await storedRecords();

      const [res] = await race.real([
        [
          "EVAL",
          mod.RENAME_CATEGORY_SCRIPT,
          2,
          CATS,
          ITEMS,
          "1",
          JSON.stringify(["Webb"]),
          JSON.stringify(["Web"]),
          "Webb",
          "a",
          JSON.stringify(record("a", "Webb")),
          JSON.stringify(record("a", "Web")),
        ],
      ]);
      expect(res.result).toBe(0);
      expect(await storedList()).toEqual(["Webb", "Pwn"]);
      expect(await storedRecords()).toEqual(before);
    });

    it("refuses when a challenge in the category was not in the plan, writing nothing", async () => {
      await setList(["Webb"]);
      await putChallenge(record("a", "Webb"));
      await putChallenge(record("b", "Webb"));
      const raw = JSON.stringify(["Webb"]);

      const [res] = await race.real([
        [
          "EVAL",
          mod.RENAME_CATEGORY_SCRIPT,
          2,
          CATS,
          ITEMS,
          "1",
          raw,
          JSON.stringify(["Web"]),
          "Webb",
          "a",
          JSON.stringify(record("a", "Webb")),
          JSON.stringify(record("a", "Web")),
        ],
      ]);
      expect(res.result).toBe(0);
      expect(await storedList()).toEqual(["Webb"]);
      expect((await storedRecords()).a.category).toBe("Webb");
    });

    it("errors BEFORE its first write when the challenge key holds the wrong type", async () => {
      // A Lua script's earlier writes are not rolled back by a later error, so
      // every read that can fail comes before the first write.
      await setList(["Webb"]);
      await race.real([["SET", ITEMS, "not a hash"]]);
      const [res] = await race.real([
        ["EVAL", mod.RENAME_CATEGORY_SCRIPT, 2, CATS, ITEMS, "1", JSON.stringify(["Webb"]), JSON.stringify(["Web"]), "Webb"],
      ]);
      expect(res.error).toBeTruthy();
      expect(await storedList()).toEqual(["Webb"]);
    });
  });

  describe("renameCategoryAtomically", () => {
    it("moves every challenge in the category and rewrites the list in one step", async () => {
      await setList(["Webb", "Pwn"]);
      await putChallenge(record("a", "Webb"));
      await putChallenge(record("b", "Pwn"));
      await putChallenge(record("c", "Webb"));

      const outcome = await mod.renameCategoryAtomically(KEYS, "Webb", "Web");
      expect(outcome).toEqual({ kind: "renamed", categories: ["Web", "Pwn"], moved: 2 });
      expect(await storedList()).toEqual(["Web", "Pwn"]);
      const rows = await storedRecords();
      expect(rows.a).toEqual(record("a", "Web"));
      expect(rows.b).toEqual(record("b", "Pwn"));
      expect(rows.c).toEqual(record("c", "Web"));
    });

    it("KEEPS a category another organizer added while the rename was in flight", async () => {
      // The worst of the old read-modify-write paths: the rename read the list,
      // a concurrent add landed, and the rename's rewritten list erased it.
      await setList(["Webb", "Pwn"]);
      await putChallenge(record("a", "Webb"));
      race.beforeEval.push(() => setList(["Webb", "Pwn", "Misc"]).then(() => undefined));

      const outcome = await mod.renameCategoryAtomically(KEYS, "Webb", "Web");
      expect(outcome).toEqual({ kind: "renamed", categories: ["Web", "Pwn", "Misc"], moved: 1 });
      expect(await storedList()).toEqual(["Web", "Pwn", "Misc"]);
      expect((await storedRecords()).a.category).toBe("Web");
    });

    it("carries across a challenge filed into the category while the rename was in flight", async () => {
      await setList(["Webb"]);
      await putChallenge(record("a", "Webb"));
      race.beforeEval.push(() => putChallenge(record("late", "Webb")));

      const outcome = await mod.renameCategoryAtomically(KEYS, "Webb", "Web");
      expect(outcome).toEqual({ kind: "renamed", categories: ["Web"], moved: 2 });
      const rows = await storedRecords();
      // Left on "Webb" it would be invisible: the board filters on exact
      // equality against a list that no longer holds that name.
      expect(rows.late.category).toBe("Web");
      expect(rows.a.category).toBe("Web");
    });

    it("keeps an edit made to a challenge being moved, rather than writing its stale copy back", async () => {
      await setList(["Webb"]);
      await putChallenge(record("a", "Webb", 100));
      race.beforeEval.push(() => putChallenge(record("a", "Webb", 500)));

      await mod.renameCategoryAtomically(KEYS, "Webb", "Web");
      expect((await storedRecords()).a).toEqual(record("a", "Web", 500));
    });

    it("reports the source missing when another organizer renamed it first", async () => {
      await setList(["Webb"]);
      await putChallenge(record("a", "Webb"));
      race.beforeEval.push(async () => {
        await setList(["Website"]);
        await putChallenge(record("a", "Website"));
      });

      expect(await mod.renameCategoryAtomically(KEYS, "Webb", "Web")).toEqual({ kind: "missing" });
      expect(await storedList()).toEqual(["Website"]);
      expect((await storedRecords()).a.category).toBe("Website");
    });

    it("gives up with a conflict under sustained contention, having lost nothing", async () => {
      await setList(["Webb"]);
      await putChallenge(record("a", "Webb"));
      let n = 0;
      race.everyEval = async () => {
        n += 1;
        const [res] = await race.real([["GET", CATS]]);
        await race.real([["SET", CATS, JSON.stringify([...(JSON.parse(String(res.result)) as string[]), `New ${n}`])]]);
      };

      await expect(mod.renameCategoryAtomically(KEYS, "Webb", "Web")).rejects.toBeInstanceOf(mod.CategoryConflictError);
      expect(race.evals).toBe(mod.CATEGORY_WRITE_ATTEMPTS);
      // Every concurrent add is still there, and the rename touched nothing.
      expect(await storedList()).toEqual(["Webb", ...Array.from({ length: n }, (_, i) => `New ${i + 1}`)]);
      expect((await storedRecords()).a.category).toBe("Webb");
    });

    it("fails without writing when the challenge key holds the wrong type", async () => {
      await setList(["Webb"]);
      await race.real([["SET", ITEMS, "not a hash"]]);
      await expect(mod.renameCategoryAtomically(KEYS, "Webb", "Web")).rejects.toThrow();
      expect(await storedList()).toEqual(["Webb"]);
    });
  });
});
