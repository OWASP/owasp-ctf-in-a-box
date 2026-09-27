// Unit tests for the classic challenge store — most importantly that NEITHER
// flag hash (`ctf:classic:flag`, the flag as authored, or
// `ctf:classic:flagnorm`, the normalized form grading compares) ever reaches a
// caller that only asked for challenges.
//
// The flags ARE readable by exactly one function, `listChallengesForAdmin`,
// whose only caller is the `requireAdmin`-gated `GET /api/admin/classic`. The
// two are pinned apart below: `listChallenges` must never issue a command
// against either flag hash, and `listChallengesForAdmin` must return the flag
// in its own field.
//
// The gate and `submitFlag` live in classic-store.grade.test.ts instead —
// they need a PARTIAL `@/lib/admin-store` mock (real `effectivePaused`, mocked
// `getAdminSettings`), and forcing both halves into one file would mean a
// compromised mock for both.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import {
  CLASSIC_CATEGORIES_MAX,
  CLASSIC_CATEGORY_MAX_LEN,
  CLASSIC_POINTS_MAX,
  ClassicValidationError,
  clearChallenges,
  deleteChallenge,
  exportBundle,
  getClassicTotals,
  getSolveCounts,
  getTeamClassicTotalsBatch,
  getViewerClassic,
  importBundle,
  listCategories,
  listChallenges,
  listChallengesForAdmin,
  renameCategory,
  setCategories,
  upsertChallenge,
  type AdminChallenge,
  type Challenge,
} from "@/lib/classic-store";
import { CLASSIC_BUNDLE_VERSION, type ClassicBundle } from "@/lib/classic-io";
import { MARKDOWN_MAX } from "@/lib/markdown";

/** Every `upstashPipeline` call's command list, oldest first. */
const pipelineCalls = (): (string | number)[][][] =>
  mocks.upstashPipeline.mock.calls.map((call) => call[0] as (string | number)[][]);

/** The next pipeline reply is a `GET ctf:classic:categories` returning these
 *  names — `upsertChallenge` reads the category list before it writes. */
function categoriesReply(names: string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(names) }]);
}

/** The next pipeline reply is `n` successful writes. */
function writeReply(n: number) {
  mocks.upstashPipeline.mockResolvedValueOnce(Array.from({ length: n }, () => ({ result: 1 })));
}

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  id: "chal-1",
  title: "A challenge",
  category: "Web",
  description: "Find the flag.",
  points: 50,
  order: 1,
  ...over,
});

const row = (c: Challenge) => [c.id, JSON.stringify(c)];

/** Every command (across every pipeline call so far) targeting `key`. */
const commandsFor = (key: string) => pipelineCalls().flat().filter((c) => c[1] === key);

/** Every argument (from index 2 on) of commands targeting `key`, across
 *  every pipeline call made so far — used to assert a value was written
 *  SOMEWHERE without caring which row carried it. */
const flatArgsFor = (key: string): (string | number)[] => commandsFor(key).flatMap((c) => c.slice(2));

/** The stored value for `key` — for a hash write (`HSET key id value`) pass
 *  `id` to pick that row's value; for a plain key write (`SET key value`)
 *  omit it. Reads back out of whichever pipeline call actually wrote it. */
function valueFor(key: string, id?: string): string {
  const commands = commandsFor(key);
  const match = id === undefined ? commands[commands.length - 1] : commands.find((c) => c[2] === id);
  if (!match) throw new Error(`no command found for ${key}${id ? `/${id}` : ""}`);
  return String(id === undefined ? match[2] : match[3]);
}

/** Queues the reply for `importBundle`'s leading membership read (HKEYS
 *  challenges, GET categories): the board already has these challenge ids,
 *  and no categories yet. */
function seedChallenges(ids: string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: ids }, { result: null }]);
}

/** Queues the reply for `importBundle`'s leading read, with these
 *  categories already on the board and no challenges yet. */
function seedCategories(names: string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { result: JSON.stringify(names) }]);
}

const FULL_BOARD_ID = "web-one-ab12cd";

/** Queues replies for `exportBundle`'s two reads (`listChallengesForAdmin`,
 *  then `listCategories`) describing a one-challenge, two-category board. */
function seedFullBoard() {
  mocks.upstashPipeline.mockResolvedValueOnce([
    {
      result: row(
        challenge({ id: FULL_BOARD_ID, title: "One", category: "Web", description: "**find it**", points: 50, order: 0 }),
      ),
    },
    { result: [FULL_BOARD_ID, "ctfbox{One}"] },
    { result: [] },
  ]);
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web", "Crypto"]) }]);
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
}

/** Clears recorded pipeline calls (so a following assertion only sees what
 *  happens NEXT) while re-seeding the board `seedFullBoard` established, so
 *  a subsequent `importBundle` still sees it as already on the store — the
 *  property a round-trip test depends on. */
function resetPipelineCalls() {
  mocks.upstashPipeline.mockClear();
  seedChallenges([FULL_BOARD_ID]);
}

const twoRowBundle: ClassicBundle = {
  version: CLASSIC_BUNDLE_VERSION,
  categories: ["Web", "Crypto"],
  challenges: [
    {
      id: "web-one-ab12cd",
      title: "One",
      category: "Web",
      description: "**find it**",
      points: 50,
      order: 0,
      flag: "ctfbox{One}",
    },
    {
      id: "crypto-two-cd34ef",
      title: "Two",
      category: "Crypto",
      description: "harder",
      points: 100,
      order: 1,
      flag: "ctfbox{Two}",
    },
  ],
};

const bundleWithFlag = (flag: string): ClassicBundle => ({
  version: CLASSIC_BUNDLE_VERSION,
  categories: ["Web"],
  challenges: [
    { id: "web-one-ab12cd", title: "One", category: "Web", description: "find it", points: 50, order: 0, flag },
  ],
});

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashEval.mockReset();
  // Default: every hash read comes back empty. Tests that care queue their own
  // reply with `mockResolvedValueOnce`, which takes precedence.
  mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }, { result: [] }]);
});

describe("listChallenges", () => {
  it("never issues a command against either flag hash", async () => {
    await listChallenges();
    const commands = pipelineCalls().flat();
    const keys = commands.map((c) => c[1]);
    expect(keys).not.toContain("ctf:classic:flag");
    expect(keys).not.toContain("ctf:classic:flagnorm");
    // Belt and braces: not as an argument to some other command either.
    expect(JSON.stringify(commands)).not.toContain("ctf:classic:flag");
  });

  it("sorts by points ascending, then order, then id", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          ...row(challenge({ id: "dear-a", points: 200, order: 1 })),
          ...row(challenge({ id: "cheap-b", points: 50, order: 2 })),
          ...row(challenge({ id: "cheap-a", points: 50, order: 1 })),
        ],
      },
    ]);
    const list = await listChallenges();
    expect(list.map((c) => c.id)).toEqual(["cheap-a", "cheap-b", "dear-a"]);
  });

  it("falls back to id order when points and order both tie", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          ...row(challenge({ id: "b", points: 50, order: 1 })),
          ...row(challenge({ id: "a", points: 50, order: 1 })),
        ],
      },
    ]);
    expect((await listChallenges()).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("drops unparseable rows instead of throwing", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [...row(challenge({ id: "chal-1" })), "bad", "not json"] },
    ]);
    expect((await listChallenges()).map((c) => c.id)).toEqual(["chal-1"]);
  });

  it("returns an empty list when the hash is empty", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }]);
    expect(await listChallenges()).toEqual([]);
  });

  // Grading reads the STORED JSON in Lua and never touches the parsed object,
  // so a parser that drops `caseSensitive` still grades correctly — and the
  // board silently stops telling the contestant the flag is case-sensitive.
  // That is the one failure the board can explain for free (issue #193), so
  // the read-back is asserted here rather than inferred from the write.
  it("carries caseSensitive back off the stored record", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: "a", caseSensitive: true })) },
    ]);
    const [first] = await listChallenges();
    expect(first.caseSensitive).toBe(true);
  });

  it("leaves caseSensitive absent on a record stored without it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: row(challenge({ id: "a" })) }]);
    const [first] = await listChallenges();
    // Absent, not `false`: the board renders the badge on truthiness, and the
    // stored record omits the field entirely when it is off.
    expect(first.caseSensitive).toBeUndefined();
  });
});

describe("listChallengesForAdmin", () => {
  it("returns each challenge WITH its authored flag, reading both hashes in one pipeline", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [...row(challenge({ id: "b", points: 100 })), ...row(challenge({ id: "a", points: 50 }))] },
      { result: ["a", "CTF{Aaa}", "b", "CTF{Bbb}"] },
      { result: ["a", "Look closer."] },
    ]);

    const rows = await listChallengesForAdmin();

    expect(rows.map((r) => r.challenge.id)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.flag)).toEqual(["CTF{Aaa}", "CTF{Bbb}"]);
    // The hint rides back for the edit form too — absent = null (#190).
    expect(rows.map((r) => r.hint)).toEqual(["Look closer.", null]);
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(pipelineCalls()[0]).toEqual([
      ["HGETALL", "ctf:classic:challenges"],
      // The AUTHORED flag, not the normalized one: an edit form must show the
      // organizer what they typed, casing included.
      ["HGETALL", "ctf:classic:flag"],
      ["HGETALL", "ctf:classic:hints"],
    ]);
  });

  it("keeps the flag in its OWN field, never merged into the challenge record", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: "a" })) },
      { result: ["a", "CTF{secret}"] },
      { result: [] },
    ]);
    const [first] = await listChallengesForAdmin();
    // The shape is load-bearing: `AdminChallenge` is deliberately not
    // assignable to `Challenge`, which is what makes handing an admin row to a
    // contestant-facing component a compile error rather than a leak.
    expect(Object.keys(first)).toEqual(["challenge", "flag", "hint"]);
    expect(JSON.stringify(first.challenge)).not.toContain("CTF{secret}");
  });

  it("reports a missing flag row as empty rather than hiding the challenge", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: row(challenge({ id: "a" })) }, { result: [] }, { result: [] }]);
    expect(await listChallengesForAdmin()).toEqual([{ challenge: challenge({ id: "a" }), flag: "", hint: null }]);
  });

  // The edit form checks its box off this value. A parser that drops it hands
  // the organizer an unchecked box for a case-sensitive challenge, and saving
  // any other field then writes `caseSensitive: false` and re-normalizes the
  // flag row — a silent downgrade with no warning and no way to notice.
  it("carries caseSensitive back for the edit form", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: "a", caseSensitive: true })) },
      { result: ["a", "CTF{Aaa}"] },
      { result: [] },
    ]);
    const [first] = await listChallengesForAdmin();
    expect(first.challenge.caseSensitive).toBe(true);
  });
});

describe("categories", () => {
  it("reads the stored list in the organizer's order", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web", "Crypto"]) }]);
    expect(await listCategories()).toEqual(["Web", "Crypto"]);
  });

  it("reads an absent or unparseable list as empty rather than throwing", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await listCategories()).toEqual([]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "{not json" }]);
    expect(await listCategories()).toEqual([]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web", 7]) }]);
    expect(await listCategories()).toEqual(["Web"]);
  });

  it("stores the trimmed list, deduped case-insensitively, order preserved", async () => {
    writeReply(1);
    const stored = await setCategories(["  Web  ", "Crypto", "web"]);
    expect(stored).toEqual(["Web", "Crypto"]);
    expect(pipelineCalls()[0]).toEqual([["SET", "ctf:classic:categories", JSON.stringify(["Web", "Crypto"])]]);
  });

  it("rejects an empty, oversized, or non-string name and an oversized list", async () => {
    await expect(setCategories(["  "])).rejects.toThrow(ClassicValidationError);
    await expect(setCategories(["x".repeat(CLASSIC_CATEGORY_MAX_LEN + 1)])).rejects.toThrow(ClassicValidationError);
    await expect(setCategories([7 as never])).rejects.toThrow(ClassicValidationError);
    await expect(
      setCategories(Array.from({ length: CLASSIC_CATEGORIES_MAX + 1 }, (_, i) => `c${i}`)),
    ).rejects.toThrow(ClassicValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("upsertChallenge", () => {
  const base = challenge();

  it("writes flag and flagnorm in ONE pipeline so they cannot disagree", async () => {
    categoriesReply(["Web"]);
    writeReply(3);
    await upsertChallenge(base, "  CTF{Flag}  ");
    const [call] = pipelineCalls().slice(-1);
    const keys = call.map((c) => c[1]);
    // The hint row rides in the SAME pipeline (written or cleared) — the
    // fourth key is #190's, and a hint-less upsert clears it.
    expect(keys).toEqual(["ctf:classic:challenges", "ctf:classic:flag", "ctf:classic:flagnorm", "ctf:classic:hints"]);
  });

  it("stores the flag as authored and the normalized form separately", async () => {
    categoriesReply(["Web"]);
    writeReply(3);
    await upsertChallenge(base, "  CTF{Flag}  ");
    const [call] = pipelineCalls().slice(-1);
    expect(call[1][3]).toBe("CTF{Flag}"); // trimmed, casing preserved
    expect(call[2][3]).toBe("ctf{flag}"); // normalized
  });

  it("never writes a flag into the public challenge record", async () => {
    categoriesReply(["Web"]);
    writeReply(3);
    await upsertChallenge(base, "CTF{Flag}");
    const [call] = pipelineCalls().slice(-1);
    expect(String(call[0][3])).not.toContain("CTF{Flag}");
    expect(String(call[0][3])).not.toContain("ctf{flag}");
  });

  it("returns what was stored, with the flag trimmed", async () => {
    categoriesReply(["Web"]);
    writeReply(3);
    expect(await upsertChallenge(base, "  CTF{Flag}  ")).toEqual({ challenge: base, flag: "CTF{Flag}", hint: null });
  });

  it("rejects a challenge whose category is not a known category", async () => {
    categoriesReply(["Web"]);
    await expect(upsertChallenge({ ...base, category: "ghost" }, "f")).rejects.toThrow(ClassicValidationError);
    // Nothing was written.
    expect(pipelineCalls()).toHaveLength(1);
  });

  it("rejects non-integer, negative, and oversized points", async () => {
    for (const points of [1.5, -1, 1e21, CLASSIC_POINTS_MAX + 1]) {
      categoriesReply(["Web"]);
      await expect(upsertChallenge({ ...base, points }, "f")).rejects.toThrow(ClassicValidationError);
    }
  });

  it("rejects an empty flag", async () => {
    categoriesReply(["Web"]);
    await expect(upsertChallenge(base, "   ")).rejects.toThrow(ClassicValidationError);
  });

  it("rejects a malformed id and an empty title before reading anything", async () => {
    await expect(upsertChallenge({ ...base, id: "bad id" }, "f")).rejects.toThrow(ClassicValidationError);
    await expect(upsertChallenge({ ...base, title: "   " }, "f")).rejects.toThrow(ClassicValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("rejects a description past the markdown cap", async () => {
    categoriesReply(["Web"]);
    await expect(upsertChallenge({ ...base, description: "x".repeat(MARKDOWN_MAX + 1) }, "f")).rejects.toThrow(
      ClassicValidationError,
    );
  });

  it("surfaces an Upstash write failure as a plain Error, distinct from a validation error", async () => {
    categoriesReply(["Web"]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { error: "WRONGTYPE" }, { result: 1 }]);
    await expect(upsertChallenge(base, "f")).rejects.not.toBeInstanceOf(ClassicValidationError);
  });
});

describe("AdminChallenge", () => {
  it("is not assignable to Challenge", () => {
    // Compile-time guarantee, asserted here so the intent is documented.
    // @ts-expect-error AdminChallenge must NOT be usable where Challenge is.
    const c: Challenge = {} as AdminChallenge;
    void c;
  });
});

describe("deleteChallenge", () => {
  it("removes the challenge and BOTH flag rows, leaving history and aggregates alone", async () => {
    writeReply(3);
    // The stories read that follows (#463): none stored, so nothing to prune.
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    await deleteChallenge("chal-1");
    expect(pipelineCalls()[0]).toEqual([
      ["HDEL", "ctf:classic:challenges", "chal-1"],
      ["HDEL", "ctf:classic:flag", "chal-1"],
      ["HDEL", "ctf:classic:flagnorm", "chal-1"],
      // The hint row retires with its challenge (#190).
      ["HDEL", "ctf:classic:hints", "chal-1"],
    ]);
    // Deliberately NOT the per-login solve/attempt hashes or the aggregate
    // counters — see deleteChallenge's contract.
    const keys = pipelineCalls().flat().map((c) => c[1]);
    expect(keys).not.toContain("ctf:classic:points");
    expect(keys).not.toContain("ctf:classic:solved");
    expect(keys).not.toContain("ctf:classic:solvecount");
  });

  it("rejects a malformed id without touching Upstash", async () => {
    await expect(deleteChallenge("../etc")).rejects.toThrow(ClassicValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("clearChallenges", () => {
  it("deletes only the content keys, never run state", async () => {
    mocks.upstashPipeline.mockResolvedValue([]);
    await clearChallenges();
    const sent = mocks.upstashPipeline.mock.calls.at(-1)![0] as string[][];
    const deleted = sent.filter((c) => c[0] === "DEL").flatMap((c) => c.slice(1));
    expect(deleted).toEqual(
      expect.arrayContaining([
        "ctf:classic:challenges",
        "ctf:classic:flag",
        "ctf:classic:flagnorm",
        "ctf:classic:categories",
        "ctf:classic:hints",
      ]),
    );
    expect(deleted).not.toContain("ctf:classic:points");
    expect(deleted).not.toContain("ctf:classic:solved");
    expect(deleted.some((k) => k.startsWith("ctf:classic:solves:"))).toBe(false);
  });

  it("surfaces a per-command pipeline error instead of swallowing it", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: 1 },
      { error: "WRONGTYPE" },
      { result: 1 },
      { result: 1 },
      { result: 1 },
    ]);
    await expect(clearChallenges()).rejects.toThrow(/WRONGTYPE/);
  });
});

describe("getViewerClassic", () => {
  it("returns the caller's solves and never reads a flag hash", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["chal-1", JSON.stringify({ points: 50, at: "2026-08-19T10:00:00.000Z" }), "bad", "not json"] },
      { result: [] },
    ]);
    const viewer = await getViewerClassic("alice");
    expect(viewer).toEqual({ solved: { "chal-1": { points: 50, at: "2026-08-19T10:00:00.000Z" } }, attempts: {} });
    const keys = pipelineCalls().flat().map((c) => c[1]);
    expect(keys).toEqual(["ctf:classic:solves:alice", "ctf:classic:attempts:alice"]);
    expect(JSON.stringify(pipelineCalls())).not.toMatch(/ctf:classic:flag/);
  });

  // The gap this task closes: the board needs `attempts` (mirroring
  // `ViewerQuiz.attempts`) to derive a server-side cooldown status, in the
  // SAME pipeline call as the solves read — one extra HGETALL, no change to
  // the existing solved-only behaviour, and still no flag hash touched.
  it("also returns every attempt (right or wrong), keyed by challenge id, in the same pipeline", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["chal-1", JSON.stringify({ points: 50, at: "2026-08-19T10:00:00.000Z" })] },
      {
        result: [
          "chal-1",
          JSON.stringify({ attempts: 1, lastAt: "2026-08-19T09:59:00.000Z", lastAtMs: 1755597540000 }),
          "chal-2",
          JSON.stringify({ attempts: 3, lastAt: "2026-08-19T09:00:00.000Z", lastAtMs: 1755594000000 }),
          "bad",
          "not json",
        ],
      },
    ]);

    const viewer = await getViewerClassic("alice");

    expect(viewer.solved).toEqual({ "chal-1": { points: 50, at: "2026-08-19T10:00:00.000Z" } });
    expect(viewer.attempts).toEqual({
      "chal-1": { attempts: 1, lastAt: "2026-08-19T09:59:00.000Z" },
      "chal-2": { attempts: 3, lastAt: "2026-08-19T09:00:00.000Z" },
    });
    // ONE pipeline call carrying both HGETALLs, not two round trips.
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(pipelineCalls()[0]).toEqual([
      ["HGETALL", "ctf:classic:solves:alice"],
      ["HGETALL", "ctf:classic:attempts:alice"],
    ]);
  });

  it("returns empty solved/attempts when both hashes are empty", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { result: [] }]);
    expect(await getViewerClassic("alice")).toEqual({ solved: {}, attempts: {} });
  });
});

describe("getSolveCounts", () => {
  it("reads the per-challenge solve counter in one call", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["chal-1", "3", "chal-2", "1"] }]);
    expect([...(await getSolveCounts())]).toEqual([
      ["chal-1", 3],
      ["chal-2", 1],
    ]);
    expect(pipelineCalls()[0]).toEqual([["HGETALL", "ctf:classic:solvecount"]]);
  });
});

describe("getClassicTotals", () => {
  it("unions the two aggregate hashes into one total per login, in two round trips", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["alice", "150", "bob", "50"] },
      { result: ["alice", "2"] },
    ]);
    const totals = await getClassicTotals();
    expect(totals.get("alice")).toEqual({ points: 150, solved: 2, lastAt: null });
    expect(totals.get("bob")).toEqual({ points: 50, solved: 0, lastAt: null });
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("getTeamClassicTotalsBatch", () => {
  const solves = (rows: Record<string, { points: number; at: string }>) => ({
    result: Object.entries(rows).flatMap(([id, v]) => [id, JSON.stringify(v)]),
  });

  it("counts a challenge two teammates both solved exactly once, at the earliest solve", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      solves({ "chal-1": { points: 50, at: "2026-08-19T10:00:00.000Z" } }),
      solves({ "chal-1": { points: 90, at: "2026-08-19T11:00:00.000Z" } }),
    ]);
    const [total] = await getTeamClassicTotalsBatch([["alice", "bob"]]);
    expect(total).toEqual({ points: 50, solved: 1, lastAt: "2026-08-19T10:00:00.000Z", itemIds: ["chal-1"] });
  });

  it("issues ONE pipeline for the whole board and fetches a shared member once", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([solves({}), solves({}), solves({})]);
    await getTeamClassicTotalsBatch([
      ["alice", "bob"],
      ["bob", "carol"],
    ]);
    expect(pipelineCalls()).toHaveLength(1);
    expect(pipelineCalls()[0]).toEqual([
      ["HGETALL", "ctf:classic:solves:alice"],
      ["HGETALL", "ctf:classic:solves:bob"],
      ["HGETALL", "ctf:classic:solves:carol"],
    ]); // alice, bob, carol — not 4
  });

  it("returns one total per team, in the same order, reusing a shared member's reply", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      solves({ "chal-1": { points: 50, at: "2026-08-19T10:00:00.000Z" } }), // alice
      solves({ "chal-2": { points: 10, at: "2026-08-19T09:00:00.000Z" } }), // bob
      solves({ "chal-2": { points: 10, at: "2026-08-19T12:00:00.000Z" } }), // carol
    ]);
    const totals = await getTeamClassicTotalsBatch([
      ["alice", "bob"],
      ["bob", "carol"],
    ]);
    expect(totals).toEqual([
      { points: 60, solved: 2, lastAt: "2026-08-19T10:00:00.000Z", itemIds: ["chal-1", "chal-2"] },
      { points: 10, solved: 1, lastAt: "2026-08-19T09:00:00.000Z", itemIds: ["chal-2"] },
    ]);
  });

  it("skips unparseable rows rather than throwing", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["chal-1", "not json"] }]);
    expect(await getTeamClassicTotalsBatch([["alice"]])).toEqual([{ points: 0, solved: 0, lastAt: null, itemIds: [] }]);
  });

  it("costs no round trip at all when no team has a member", async () => {
    expect(await getTeamClassicTotalsBatch([[], []])).toEqual([
      { points: 0, solved: 0, lastAt: null, itemIds: [] },
      { points: 0, solved: 0, lastAt: null, itemIds: [] },
    ]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("importBundle", () => {
  it("writes challenge, flag and flagnorm for every row in ONE pipeline", async () => {
    await importBundle(twoRowBundle);
    // The membership/union read is its OWN earlier call (mirroring
    // upsertChallenge's `listCategories()` read before its own write) — this
    // checks the WRITE call specifically, the same idiom `upsertChallenge`'s
    // own "ONE pipeline" test uses above.
    const [call] = pipelineCalls().slice(-1);
    const keys = call.map((c) => c[1]);
    expect(keys).toContain("ctf:classic:challenges");
    expect(keys).toContain("ctf:classic:flag");
    expect(keys).toContain("ctf:classic:flagnorm");
    expect(keys).toContain("ctf:classic:categories");
  });

  it("refuses to write anything when the read pipeline itself failed — a failed GET must not become an empty category list (#261)", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { error: "NOAUTH Authentication required." }]);
    await expect(importBundle(twoRowBundle)).rejects.toThrow(/NOAUTH/);
    // No second (write) pipeline: the categories the box already had are never
    // replaced by only the bundle's, and no row is re-spelled to its casing.
    expect(pipelineCalls()).toHaveLength(1);
  });

  it("stores the normalized flag via normalizeFlag, not a raw lowercase", async () => {
    await importBundle(bundleWithFlag("  CTF{Mixed}  "));
    const written = flatArgsFor("ctf:classic:flagnorm");
    expect(written).toContain("ctf{mixed}");
  });

  it("never writes a flag into the public challenge record", async () => {
    await importBundle(bundleWithFlag("ctfbox{Secret}"));
    const record = JSON.parse(valueFor("ctf:classic:challenges", "web-one-ab12cd"));
    expect(Object.keys(record)).toEqual(["id", "title", "category", "description", "points", "order"]);
    expect(JSON.stringify(record)).not.toContain("Secret");
  });

  // The caseSensitive lesson (#196), applied on day one: grading/reveal read
  // the STORED row, so these assert the write AND the read-back, not just
  // that an upsert didn't throw.
  it("writes a hint into its own secret hash, trimmed, and returns it", async () => {
    const base = challenge();
    categoriesReply(["Web"]);
    writeReply(4);
    const saved = await upsertChallenge(base, "CTF{Flag}", "  Look at robots.txt  ");
    const [call] = pipelineCalls().slice(-1);
    expect(call[3]).toEqual(["HSET", "ctf:classic:hints", base.id, "Look at robots.txt"]);
    // Never into the public record.
    expect(String(call[0][3])).not.toContain("robots.txt");
    expect(saved.hint).toBe("Look at robots.txt");
  });

  it("clears the hint row when the hint is emptied or absent", async () => {
    const base = challenge();
    categoriesReply(["Web"]);
    writeReply(4);
    await upsertChallenge(base, "CTF{Flag}", "   ");
    expect(pipelineCalls().slice(-1)[0][3]).toEqual(["HDEL", "ctf:classic:hints", base.id]);
    categoriesReply(["Web"]);
    writeReply(4);
    const saved = await upsertChallenge(base, "CTF{Flag}");
    expect(pipelineCalls().slice(-1)[0][3]).toEqual(["HDEL", "ctf:classic:hints", base.id]);
    expect(saved.hint).toBeNull();
  });

  it("rejects a hint over the cap without touching Upstash", async () => {
    const base = challenge();
    categoriesReply(["Web"]);
    await expect(upsertChallenge(base, "CTF{Flag}", "x".repeat(1001))).rejects.toThrow(ClassicValidationError);
  });

  it("reports created vs updated against what already exists", async () => {
    seedChallenges(["web-one-ab12cd"]);
    const summary = await importBundle(twoRowBundle);
    expect(summary).toEqual({ created: 1, updated: 1, categories: 2 });
  });

  // The whole reason import is upsert: an organizer must never lose authored
  // work by importing a partial file.
  it("leaves an existing challenge that the bundle does not mention untouched", async () => {
    seedChallenges(["legacy-zz99zz"]);
    await importBundle(twoRowBundle);
    // The only HDELs are hint CLEARS for the bundle's own hint-less rows —
    // never a delete of a challenge the bundle does not mention.
    const deleted = pipelineCalls().flat().filter((c) => c[0] === "HDEL");
    expect(deleted.every((c) => c[1] === "ctf:classic:hints")).toBe(true);
    expect(deleted.some((c) => String(c[2]).startsWith("legacy"))).toBe(false);
  });

  it("UNIONS categories, preserving existing order and appending new ones", async () => {
    seedCategories(["Forensics", "Web"]);
    await importBundle({ ...twoRowBundle, categories: ["Web", "Crypto"] });
    expect(JSON.parse(valueFor("ctf:classic:categories"))).toEqual(["Forensics", "Web", "Crypto"]);
  });

  // The invariant the rest of the module assumes (`setCategories`'
  // first-spelling-wins rule depends on it, and the board's exact-equality
  // filter in challenge-board.tsx depends on it too): every stored challenge's
  // `category` must appear, verbatim, in the stored category list. The union
  // above folds case-insensitively and keeps the EXISTING spelling ("Web"),
  // so a bundle that spells the same category "web" must have its challenge
  // canonicalized to "Web" — otherwise it is written under a spelling the
  // category list doesn't contain and disappears from the board.
  it("canonicalizes a stored challenge's category to the surviving (existing) spelling", async () => {
    seedCategories(["Web"]);
    const bundle: ClassicBundle = {
      version: CLASSIC_BUNDLE_VERSION,
      categories: ["web"],
      challenges: [
        {
          id: "web-one-ab12cd",
          title: "One",
          category: "web",
          description: "find it",
          points: 50,
          order: 0,
          flag: "ctfbox{One}",
        },
      ],
    };
    await importBundle(bundle);
    const record = JSON.parse(valueFor("ctf:classic:challenges", "web-one-ab12cd"));
    const categories = JSON.parse(valueFor("ctf:classic:categories"));
    expect(categories).toContain(record.category);
  });
});

describe("exportBundle", () => {
  it("returns the current board in the importable shape", async () => {
    seedFullBoard();
    const bundle = await exportBundle();
    expect(bundle.version).toBe(2);
    expect(bundle.stories).toEqual([]);
    expect(bundle.categories).toEqual(["Web", "Crypto"]);
    expect(bundle.challenges[0]).toEqual({
      id: "web-one-ab12cd",
      title: "One",
      category: "Web",
      description: "**find it**",
      points: 50,
      order: 0,
      flag: "ctfbox{One}",
    });
  });

  it("round-trips: exporting then importing writes the same ids back", async () => {
    seedFullBoard();
    const bundle = await exportBundle();
    resetPipelineCalls();
    const summary = await importBundle(bundle);
    // Every challenge already exists, so nothing is created — this is the
    // property that makes export usable as a backup.
    expect(summary.created).toBe(0);
  });

  // An export that drops `caseSensitive` turns the documented backup path into
  // a downgrade: re-importing it makes the challenge case-insensitive, and the
  // bundle looks correct in every other field while it happens.
  it("emits caseSensitive so a backup restores the same grading", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: FULL_BOARD_ID, caseSensitive: true })) },
      { result: [FULL_BOARD_ID, "ctfbox{One}"] },
      { result: [] },
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    const bundle = await exportBundle();
    expect(bundle.challenges[0].caseSensitive).toBe(true);
  });

  // Same downgrade risk as caseSensitive: an export that drops the hint makes
  // the documented backup path silently delete every hint on re-import.
  it("emits the hint so a backup restores it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: FULL_BOARD_ID })) },
      { result: [FULL_BOARD_ID, "ctfbox{One}"] },
      { result: [FULL_BOARD_ID, "Look closer."] },
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    const bundle = await exportBundle();
    expect(bundle.challenges[0].hint).toBe("Look closer.");
  });
});

// #463: bundle v2 carries stories. Import MERGES them by id (the same upsert
// rule as challenges), validates the merged list before any write, and writes
// it in the same pipeline as the challenges.
describe("stories in the bundle (#463)", () => {
  const story = (id: string, steps: string[], title = id) => ({ id, title, intro: "", steps });
  const withStories = (stories: ReturnType<typeof story>[]): ClassicBundle => ({ ...twoRowBundle, version: 2, stories });
  const storedStories = () => JSON.parse(valueFor("ctf:classic:stories")) as ReturnType<typeof story>[];

  it("exports the stored stories", async () => {
    seedFullBoard();
    mocks.upstashPipeline.mockReset();
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }, { result: [] }]);
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: FULL_BOARD_ID })) },
      { result: [FULL_BOARD_ID, "ctfbox{One}"] },
      { result: [] },
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify([story("op", [FULL_BOARD_ID], "Operation")]) }]);
    const bundle = await exportBundle();
    expect(bundle.stories).toEqual([{ id: "op", title: "Operation", intro: "", steps: [FULL_BOARD_ID] }]);
  });

  // A stored step can outlive its challenge (deleteChallenge's story update
  // is a second call). The export must not carry it: parseBundle refuses a
  // step that is not in the file, so the backup would not restore.
  it("exports stories without a step whose challenge is gone", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ id: FULL_BOARD_ID })) },
      { result: [FULL_BOARD_ID, "ctfbox{One}"] },
      { result: [] },
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify([story("op", ["ghost-zz99zz", FULL_BOARD_ID])]) }]);
    const bundle = await exportBundle();
    expect(bundle.stories).toEqual([story("op", [FULL_BOARD_ID])]);
  });

  it("a v1 bundle reads and writes no stories at all", async () => {
    seedChallenges([]);
    const summary = await importBundle(twoRowBundle);
    const keys = pipelineCalls().flat().map((c) => c[1]);
    expect(keys).not.toContain("ctf:classic:stories");
    expect(summary).toEqual({ created: 2, updated: 0, categories: 2 });
  });

  it("replaces a story with the same id and appends a new one, in the write pipeline", async () => {
    const ids = twoRowBundle.challenges.map((c) => c.id);
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [] },
      { result: null },
      { result: JSON.stringify([story("keep", ["legacy-zz99zz"]), story("op", ["old-aa11aa"], "Old")]) },
    ]);
    const summary = await importBundle(withStories([story("op", [ids[0]], "New"), story("side", [ids[1]])]));
    expect(storedStories()).toEqual([
      story("keep", ["legacy-zz99zz"]),
      story("op", [ids[0]], "New"),
      story("side", [ids[1]]),
    ]);
    // Written with the challenges, not in a pipeline of its own.
    const write = pipelineCalls().slice(-1)[0].map((c) => c[1]);
    expect(write).toContain("ctf:classic:challenges");
    expect(write).toContain("ctf:classic:stories");
    expect(summary.stories).toBe(2);
  });

  it("refuses the whole import before any write when the merge puts a challenge in two stories", async () => {
    const ids = twoRowBundle.challenges.map((c) => c.id);
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [] },
      { result: null },
      { result: JSON.stringify([story("keep", [ids[0]])]) },
    ]);
    await expect(importBundle(withStories([story("op", [ids[0]])]))).rejects.toThrow(ClassicValidationError);
    expect(pipelineCalls()).toHaveLength(1);
  });

  it("refuses to write anything when the stories read failed", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { result: null }, { error: "NOAUTH" }]);
    await expect(importBundle(withStories([]))).rejects.toThrow(/NOAUTH/);
    expect(pipelineCalls()).toHaveLength(1);
  });

  it("refuses a corrupt stored stories value rather than overwriting it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { result: null }, { result: "{not json" }]);
    await expect(importBundle(withStories([]))).rejects.toThrow();
    expect(pipelineCalls()).toHaveLength(1);
  });
});

// #304. `setCategories` replaces the whole array, so a renamed entry is
// indistinguishable from "one removed, one added" — which is how challenges
// lost their association with it, and why `removeCategory` refuses while any
// challenge still uses a name. A typo in a category ten challenges carried
// meant editing all ten.
describe("renameCategory", () => {
  const CATEGORIES_KEY = "ctf:classic:categories";
  const CHALLENGES_KEY = "ctf:classic:challenges";

  const challenge = (id: string, category: string) => ({
    id,
    title: `T ${id}`,
    category,
    description: "",
    points: 100,
    order: 1,
  });

  /** Drives the read order: categories GET, then the challenges HGETALL, then
   *  the writes. */
  function mockStore(categories: string[], challenges: ReturnType<typeof challenge>[]) {
    mocks.upstashPipeline.mockReset();
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: JSON.stringify(categories) }])
      .mockResolvedValueOnce([{ result: challenges.flatMap((c) => [c.id, JSON.stringify(c)]) }])
      .mockResolvedValue([{ result: "OK" }, { result: "OK" }, { result: "OK" }]);
  }

  it("moves every challenge in the category and rewrites the list", async () => {
    mockStore(["Webb", "Crypto"], [challenge("a", "Webb"), challenge("b", "Crypto"), challenge("c", "Webb")]);
    const result = await renameCategory("Webb", "Web");

    expect(result).toEqual({ categories: ["Web", "Crypto"], moved: 2 });

    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    // Challenges FIRST, list LAST — the order that makes a half-applied
    // rename finishable by simply running it again.
    const writes = calls[2];
    expect(writes.map((cmd: string[]) => cmd[0])).toEqual(["HSET", "HSET"]);
    expect(writes.every((cmd: string[]) => cmd[1] === CHALLENGES_KEY)).toBe(true);
    expect(writes.map((cmd: string[]) => JSON.parse(cmd[3]).category)).toEqual(["Web", "Web"]);
    // The untouched challenge is not rewritten at all.
    expect(writes.map((cmd: string[]) => cmd[2])).toEqual(["a", "c"]);

    const listWrite = calls[3];
    expect(listWrite).toEqual([["SET", CATEGORIES_KEY, JSON.stringify(["Web", "Crypto"])]]);
  });

  it("rewrites the list even when no challenge uses the category", async () => {
    mockStore(["Webb", "Crypto"], [challenge("b", "Crypto")]);
    expect(await renameCategory("Webb", "Web")).toEqual({ categories: ["Web", "Crypto"], moved: 0 });
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    // No empty HSET batch is sent — the list write follows the two reads.
    expect(calls[2]).toEqual([["SET", CATEGORIES_KEY, JSON.stringify(["Web", "Crypto"])]]);
  });

  it("keeps the category's position in the display order", async () => {
    mockStore(["Alpha", "Webb", "Zeta"], []);
    expect((await renameCategory("Webb", "Web")).categories).toEqual(["Alpha", "Web", "Zeta"]);
  });

  it("refuses a name another category already holds, rather than merging", async () => {
    // Merging two categories is a different, lossier operation. It should be
    // asked for, not arrived at by typing an existing name into a rename box.
    mockStore(["Web", "Crypto"], []);
    await expect(renameCategory("Crypto", "web")).rejects.toBeInstanceOf(ClassicValidationError);
  });

  it("allows a change of spelling on the SAME entry", async () => {
    // "web" -> "Web" collides only with the entry being renamed, which is not
    // a collision at all.
    mockStore(["web", "Crypto"], [challenge("a", "web")]);
    expect(await renameCategory("web", "Web")).toEqual({ categories: ["Web", "Crypto"], moved: 1 });
  });

  it("refuses an unknown source, an empty target and an over-long one", async () => {
    mockStore(["Web"], []);
    await expect(renameCategory("Nope", "Other")).rejects.toBeInstanceOf(ClassicValidationError);
    await expect(renameCategory("Web", "   ")).rejects.toBeInstanceOf(ClassicValidationError);
    await expect(renameCategory("Web", "x".repeat(CLASSIC_CATEGORY_MAX_LEN + 1))).rejects.toBeInstanceOf(
      ClassicValidationError,
    );
  });

  it("does NOT rewrite the list when the challenge READ failed", async () => {
    // The subtler half of the same AGENTS.md rule. `listChallenges` reads
    // `.result` without checking `.error`, so a failed HGETALL comes back as an
    // empty list — indistinguishable from "no challenge uses this category".
    // Renaming on top of that would rewrite the list while moving nothing:
    // every challenge in the category orphaned onto a name that no longer
    // exists, and a retry unable to find the source to finish from.
    mocks.upstashPipeline.mockReset();
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: JSON.stringify(["Webb"]) }])
      .mockResolvedValueOnce([{ error: "WRONGTYPE" }]);

    await expect(renameCategory("Webb", "Web")).rejects.toThrow(/HGETALL failed/);
    // Two pipelines: the categories read and the failed challenge read. No
    // SET followed.
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(2);
  });

  it("does NOT rewrite the list when a challenge write failed", async () => {
    // `upstashPipeline` reports a per-command failure as a value, not a throw
    // (AGENTS.md). Reading `.result` blindly would report a partial move as a
    // complete one and then rewrite the list on top of it — landing in the
    // state the write order exists to avoid, and which a retry could not
    // finish from.
    mocks.upstashPipeline.mockReset();
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: JSON.stringify(["Webb"]) }])
      .mockResolvedValueOnce([{ result: [ "a", JSON.stringify(challenge("a", "Webb")) ] }])
      .mockResolvedValueOnce([{ error: "WRONGTYPE" }]);

    await expect(renameCategory("Webb", "Web")).rejects.toThrow(/HSET failed/);
    // Three pipelines: two reads and the failed write. No list SET followed.
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(3);
  });
});
