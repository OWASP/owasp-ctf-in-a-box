// Unit tests for the quiz store — most importantly that the answer key
// (`ctf:quiz:key`) never reaches a caller that only asked for questions, and
// that the key always stores a sorted array regardless of question type.
//
// The key IS readable by exactly one function, `listQuestionsForAdmin`, whose
// only caller is the `requireAdmin`-gated `GET /api/admin/quiz`. The two are
// pinned apart below: `listQuestions` must never issue a command against
// `ctf:quiz:key`, and `listQuestionsForAdmin` must return the set.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import {
  clearQuestions,
  deleteQuestion,
  getQuizTotals,
  getTeamQuizTotalsBatch,
  getViewerQuiz,
  listQuestions,
  listQuestionsForAdmin,
  QUIZ_POINTS_MAX,
  upsertQuestion,
  importBundle,
  exportBundle,
} from "@/lib/quiz-store";
import { parseBundle, serializeBundle } from "@/lib/quiz-io";

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashEval.mockReset();
});

describe("listQuestions", () => {
  it("lists questions by order and never leaks the answer key", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      {
        result: [
          "q2",
          JSON.stringify({ id: "q2", prompt: "B?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 2 }),
          "q1",
          JSON.stringify({ id: "q1", prompt: "A?", type: "multi", choices: [{ id: "a", label: "A" }], points: 10, order: 1 }),
        ],
      },
    ]);
    const qs = await listQuestions();
    expect(qs.map((q) => q.id)).toEqual(["q1", "q2"]);
    // The command list must never read the key hash.
    const cmds = JSON.stringify(mocks.upstashPipeline.mock.calls[0][0]);
    expect(cmds).not.toContain("ctf:quiz:key");
    expect(JSON.stringify(qs)).not.toMatch(/correct/i);
  });

  it("falls back to id order when order ties", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      {
        result: [
          "qb",
          JSON.stringify({ id: "qb", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 }),
          "qa",
          JSON.stringify({ id: "qa", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 }),
        ],
      },
    ]);
    const qs = await listQuestions();
    expect(qs.map((q) => q.id)).toEqual(["qa", "qb"]);
  });

  it("drops unparseable rows instead of throwing", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      {
        result: [
          "q1",
          JSON.stringify({ id: "q1", prompt: "A?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 }),
          "bad",
          "not json",
        ],
      },
    ]);
    const qs = await listQuestions();
    expect(qs.map((q) => q.id)).toEqual(["q1"]);
  });

  it("returns an empty list when the hash is empty", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }]);
    expect(await listQuestions()).toEqual([]);
  });
});

describe("listQuestionsForAdmin", () => {
  const q = (id: string, order: number) =>
    JSON.stringify({ id, prompt: `${id}?`, type: "single", choices: [{ id: "a", label: "A" }], points: 5, order });

  it("returns each question WITH its correct set, reading both hashes in one pipeline", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q2", q("q2", 2), "q1", q("q1", 1)] },
      { result: ["q1", JSON.stringify(["a"]), "q2", JSON.stringify(["a", "b"])] },
    ]);

    const rows = await listQuestionsForAdmin();

    // Sorted by order, same rule listQuestions uses.
    expect(rows.map((r) => r.question.id)).toEqual(["q1", "q2"]);
    expect(rows.map((r) => r.correct)).toEqual([["a"], ["a", "b"]]);
    // ONE round trip — the questions and their keys come from the same
    // instant, so an edit form can't prefill a set from a stale read.
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.upstashPipeline.mock.calls[0][0]).toEqual([
      ["HGETALL", "ctf:quiz:questions"],
      ["HGETALL", "ctf:quiz:key"],
    ]);
  });

  it("keeps the correct set in its OWN field, never merged into the question record", async () => {
    // The shape is load-bearing: `AdminQuestion` is deliberately not
    // assignable to `Question`, which is what makes handing an admin row to a
    // contestant-facing component a compile error rather than a leak.
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", q("q1", 1)] },
      { result: ["q1", JSON.stringify(["a"])] },
    ]);

    const [row] = await listQuestionsForAdmin();

    expect(Object.keys(row).sort()).toEqual(["correct", "question"]);
    expect(JSON.stringify(row.question)).not.toMatch(/correct/i);
  });

  it("pairs each question with ITS OWN key row, never by position", async () => {
    // The two HGETALLs come back in whatever order Redis hashes them, which
    // need not match. Pairing by index instead of by id would hand q1 the
    // answer to q2 — an organizer would then 'confirm' the wrong answer.
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", q("q1", 1), "q2", q("q2", 2)] },
      { result: ["q2", JSON.stringify(["b"]), "q1", JSON.stringify(["a"])] },
    ]);

    const rows = await listQuestionsForAdmin();
    expect(rows.find((r) => r.question.id === "q1")!.correct).toEqual(["a"]);
    expect(rows.find((r) => r.question.id === "q2")!.correct).toEqual(["b"]);
  });

  it("still returns a question whose key row is missing or unparseable, with an empty set", async () => {
    // Such a question can never be answered correctly. Surfacing it in the
    // edit form (with nothing selected) beats dropping it from the organizer's
    // list entirely, which would leave a broken question invisible.
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", q("q1", 1), "q2", q("q2", 2), "q3", q("q3", 3)] },
      { result: ["q1", "not json", "q2", JSON.stringify([1, 2])] },
    ]);

    const rows = await listQuestionsForAdmin();
    expect(rows.map((r) => [r.question.id, r.correct])).toEqual([
      ["q1", []],
      ["q2", []],
      ["q3", []],
    ]);
  });

  it("returns an empty list when there are no questions", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }]);
    expect(await listQuestionsForAdmin()).toEqual([]);
  });
});

describe("upsertQuestion", () => {
  it("stores the correct set sorted, in the key hash, separate from the question", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }, { result: "OK" }]);
    await upsertQuestion(
      {
        id: "q1",
        prompt: "Which are injection flaws?",
        type: "multi",
        choices: [
          { id: "a", label: "SQLi" },
          { id: "b", label: "XSS" },
          { id: "c", label: "LDAP" },
        ],
        points: 20,
        order: 1,
      },
      ["c", "a"],
    );
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    const keyCmd = cmds.find((c) => c[1] === "ctf:quiz:key")!;
    expect(JSON.parse(keyCmd[3])).toEqual(["a", "c"]); // sorted
    const qCmd = cmds.find((c) => c[1] === "ctf:quiz:questions")!;
    expect(qCmd[3]).not.toContain('"a","c"'); // the question record carries no answer
    expect(qCmd[3]).not.toMatch(/correct/i);
  });

  it("stores a single-element sorted array for a single-choice question", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }, { result: "OK" }]);
    await upsertQuestion(
      {
        id: "q2",
        prompt: "Pick one",
        type: "single",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        points: 5,
        order: 2,
      },
      ["b"],
    );
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    const keyCmd = cmds.find((c) => c[1] === "ctf:quiz:key")!;
    expect(JSON.parse(keyCmd[3])).toEqual(["b"]);
  });

  it("writes both hashes in a single pipeline call", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }, { result: "OK" }]);
    await upsertQuestion(
      { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 },
      ["a"],
    );
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed question id before touching Upstash", async () => {
    await expect(
      upsertQuestion(
        { id: "bad/id", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 },
        ["a"],
      ),
    ).rejects.toThrow(/invalid question id/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("rejects a malformed choice id before touching Upstash", async () => {
    await expect(
      upsertQuestion(
        { id: "q1", prompt: "?", type: "single", choices: [{ id: "bad id", label: "A" }], points: 5, order: 1 },
        ["bad id"],
      ),
    ).rejects.toThrow(/invalid choice id/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("rejects a correct id that isn't among the question's choices", async () => {
    await expect(
      upsertQuestion(
        { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 },
        ["z"],
      ),
    ).rejects.toThrow(/not among choices/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("rejects non-integer points before touching Upstash", async () => {
    await expect(
      upsertQuestion(
        { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 5.5, order: 1 },
        ["a"],
      ),
    ).rejects.toThrow(/points must be a non-negative integer/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("rejects points above the cap before touching Upstash", async () => {
    await expect(
      upsertQuestion(
        { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: QUIZ_POINTS_MAX + 1, order: 1 },
        ["a"],
      ),
    ).rejects.toThrow(new RegExp(`points must be an integer in \\[0, ${QUIZ_POINTS_MAX}\\]`, "i"));
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("rejects a points value large enough that JSON.stringify would go exponential — GRADE_SCRIPT's integer match can't read that, so it would silently award 0", async () => {
    // 1e21 is the exact threshold where JSON.stringify emits "1e+21", which
    // GRADE_SCRIPT's anchored '"points":(%-?%d+)[,}]' cannot match.
    expect(JSON.stringify({ points: 1e21 })).toContain("1e+21");
    await expect(
      upsertQuestion(
        { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: 1e21, order: 1 },
        ["a"],
      ),
    ).rejects.toThrow(/points must be an integer in/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("accepts points exactly at the cap, and stores them as a plain integer the grading script can match", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }, { result: "OK" }]);
    await upsertQuestion(
      { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: QUIZ_POINTS_MAX, order: 1 },
      ["a"],
    );
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    const qCmd = cmds.find((c) => c[1] === "ctf:quiz:questions")!;
    expect(qCmd[3]).toContain(`"points":${QUIZ_POINTS_MAX}`);
    expect(qCmd[3]).not.toMatch(/e\+/i);
  });

  it("rejects negative points before touching Upstash", async () => {
    await expect(
      upsertQuestion(
        { id: "q1", prompt: "?", type: "single", choices: [{ id: "a", label: "A" }], points: -5, order: 1 },
        ["a"],
      ),
    ).rejects.toThrow(/points must be a non-negative integer/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it('rejects a "single" question with more than one correct choice', async () => {
    await expect(
      upsertQuestion(
        {
          id: "q1",
          prompt: "?",
          type: "single",
          choices: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          points: 5,
          order: 1,
        },
        ["a", "b"],
      ),
    ).rejects.toThrow(/"single" question must have exactly one correct choice/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it('rejects a "single" question whose two correct entries dedupe down to one (still not what "exactly one" means going in)', async () => {
    // Deduping ["a","a"] down to one unique id is fine on its own (see the
    // dedupe test below) — this checks the OTHER direction: two genuinely
    // different ids on a "single" question must still be rejected even
    // though dedup doesn't collapse them.
    await expect(
      upsertQuestion(
        {
          id: "q1",
          prompt: "?",
          type: "single",
          choices: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
            { id: "c", label: "C" },
          ],
          points: 5,
          order: 1,
        },
        ["a", "b", "c"],
      ),
    ).rejects.toThrow(/"single" question must have exactly one correct choice/i);
  });

  it("dedupes the correct set before storing it, so a duplicate id can't create an unanswerable question", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }, { result: "OK" }]);
    await upsertQuestion(
      {
        id: "q1",
        prompt: "?",
        type: "multi",
        choices: [
          { id: "a", label: "A" },
          { id: "c", label: "C" },
        ],
        points: 5,
        order: 1,
      },
      ["a", "a", "c"],
    );
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    const keyCmd = cmds.find((c) => c[1] === "ctf:quiz:key")!;
    expect(JSON.parse(keyCmd[3])).toEqual(["a", "c"]);
  });

  it("returns what was STORED — the deduped, sorted set, not the caller's raw array", async () => {
    // The admin route echoes this back to the authoring client, so returning
    // the caller's array verbatim would leave the panel's list holding a set
    // the store never wrote (and a later reload would silently disagree).
    mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }, { result: "OK" }]);
    const saved = await upsertQuestion(
      {
        id: "q1",
        prompt: "?",
        type: "multi",
        choices: [
          { id: "a", label: "A" },
          { id: "c", label: "C" },
        ],
        points: 5,
        order: 1,
      },
      ["c", "a", "c"],
    );
    expect(saved.correct).toEqual(["a", "c"]);
    expect(saved.question.id).toBe("q1");
    expect(JSON.stringify(saved.question)).not.toMatch(/correct/i);
  });
});

describe("deleteQuestion", () => {
  it("deletes from both the questions hash and the key hash", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: 1 }, { result: 1 }]);
    await deleteQuestion("q1");
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    expect(cmds).toEqual([
      ["HDEL", "ctf:quiz:questions", "q1"],
      ["HDEL", "ctf:quiz:key", "q1"],
    ]);
  });

  it("rejects a malformed id before touching Upstash", async () => {
    await expect(deleteQuestion("../etc")).rejects.toThrow(/invalid question id/i);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  // The contract, pinned: retiring a question must NOT cascade into
  // contestant history. Banked points stay on the board (only the master
  // reset clears them), so no per-login hash and neither aggregate counter
  // may be touched here. The admin confirm copy and docs/operations.md both
  // promise exactly this.
  it("leaves contestant history and the aggregate counters completely untouched", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: 1 }, { result: 1 }]);
    await deleteQuestion("q1");
    const cmds = JSON.stringify(mocks.upstashPipeline.mock.calls[0][0]);
    expect(cmds).not.toContain("ctf:quiz:answers");
    expect(cmds).not.toContain("ctf:quiz:attempts");
    expect(cmds).not.toContain("ctf:quiz:points");
    expect(cmds).not.toContain("ctf:quiz:answered");
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("clearQuestions", () => {
  it("deletes only the content keys, never run state", async () => {
    mocks.upstashPipeline.mockResolvedValue([]);
    await clearQuestions();
    const sent = mocks.upstashPipeline.mock.calls.at(-1)![0] as string[][];
    const deleted = sent.filter((c) => c[0] === "DEL").flatMap((c) => c.slice(1));
    expect(deleted).toEqual(expect.arrayContaining(["ctf:quiz:questions", "ctf:quiz:key"]));
    expect(deleted).not.toContain("ctf:quiz:points");
    expect(deleted).not.toContain("ctf:quiz:answered");
  });

  it("surfaces a per-command pipeline error instead of swallowing it", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: 1 }, { error: "WRONGTYPE" }]);
    await expect(clearQuestions()).rejects.toThrow(/WRONGTYPE/);
  });
});

describe("getViewerQuiz", () => {
  it("reads only the caller's per-login hashes, never the key hash", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", JSON.stringify({ choices: ["a"], points: 10, at: "2026-01-01T00:00:00.000Z" })] },
      { result: ["q1", JSON.stringify({ attempts: 2, lastAt: "2026-01-01T00:00:00.000Z" })] },
    ]);
    const progress = await getViewerQuiz("octocat");
    expect(progress).toEqual({
      answered: { q1: { points: 10, at: "2026-01-01T00:00:00.000Z" } },
      attempts: { q1: { attempts: 2, lastAt: "2026-01-01T00:00:00.000Z" } },
    });
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    expect(cmds).toEqual([
      ["HGETALL", "ctf:quiz:answers:octocat"],
      ["HGETALL", "ctf:quiz:attempts:octocat"],
    ]);
  });

  it("returns empty records when both hashes are empty", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }]);
    expect(await getViewerQuiz("octocat")).toEqual({ answered: {}, attempts: {} });
  });

  it("drops unparseable or malformed rows instead of throwing", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", "not json", "q2", JSON.stringify({ points: 5, at: "x" })] },
      { result: ["q1", JSON.stringify({ attempts: "nope" })] },
    ]);
    const progress = await getViewerQuiz("octocat");
    expect(progress).toEqual({ answered: { q2: { points: 5, at: "x" } }, attempts: {} });
  });
});

describe("getQuizTotals", () => {
  it("reads the two aggregate counters and the award times in one pipeline call, keyed by login", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["ada", "30", "bob", "15"] },
      { result: ["ada", "3", "bob", "1"] },
      { result: ["ada", "2026-10-01T12:00:00.000Z"] },
    ]);
    const totals = await getQuizTotals();
    // #522: bob scored before the times were recorded, so he has none.
    expect(totals).toEqual(
      new Map([
        ["ada", { points: 30, answered: 3, lastAt: "2026-10-01T12:00:00.000Z" }],
        ["bob", { points: 15, answered: 1, lastAt: null }],
      ]),
    );
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    expect(cmds).toEqual([
      ["HGETALL", "ctf:quiz:points"],
      ["HGETALL", "ctf:quiz:answered"],
      ["HGETALL", "ctf:quiz:lastAt"],
    ]);
  });

  it("unions logins present in only one of the two hashes", async () => {
    // Shouldn't happen in practice (both HINCRBYs run in the same script),
    // but a login present in only one hash still gets a total, not dropped.
    mocks.upstashPipeline.mockResolvedValue([{ result: ["ada", "10"] }, { result: ["bob", "2"] }, { result: [] }]);
    const totals = await getQuizTotals();
    expect(totals).toEqual(
      new Map([
        ["ada", { points: 10, answered: 0, lastAt: null }],
        ["bob", { points: 0, answered: 2, lastAt: null }],
      ]),
    );
  });

  it("returns an empty map when nobody has answered anything", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }, { result: [] }]);
    expect(await getQuizTotals()).toEqual(new Map());
  });

  // #523: an errored counter read is not "nobody has points" — it throws, so
  // the leaderboard's own handling (log, drop the module) applies and says so.
  it.each([
    ["points", [{ error: "WRONGTYPE" }, { result: [] }, { result: [] }]],
    ["answered", [{ result: [] }, { error: "NOAUTH" }, { result: [] }]],
  ])("throws when the %s counter read fails, instead of reading it as empty", async (_name, replies) => {
    mocks.upstashPipeline.mockResolvedValue(replies);
    await expect(getQuizTotals()).rejects.toThrow(/quiz totals/);
  });

  it("still returns the totals when only the award-time read fails (it only orders ties)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockResolvedValue([{ result: ["ada", "30"] }, { result: ["ada", "3"] }, { error: "WRONGTYPE" }]);
    expect(await getQuizTotals()).toEqual(new Map([["ada", { points: 30, answered: 3, lastAt: null }]]));
  });
});

// The fold semantics for ONE team, exercised through the batch with a single
// entry. These used to run through a `getTeamQuizTotals(members)` wrapper
// that had no caller but this block; the wrapper is gone and the semantics
// it pinned — union, earliest-answer points, zero-member short-circuit,
// unparseable rows dropped — are pinned here on the function that is
// actually called.
describe("getTeamQuizTotalsBatch — one team's fold", () => {
  const oneTeam = async (members: string[]) => {
    const [total] = await getTeamQuizTotalsBatch([members]);
    return total;
  };

  it("dedupes a question answered by two members, keeping the earliest answer's points", async () => {
    // Both teammates hold a correct answer to q1 (20 points each, since both
    // answered while it was priced at 20) — the union must count it ONCE.
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", JSON.stringify({ choices: ["a"], points: 20, at: "2026-01-01T00:00:00.000Z" })] },
      { result: ["q1", JSON.stringify({ choices: ["a"], points: 20, at: "2026-01-01T01:00:00.000Z" })] },
    ]);
    const total = await oneTeam(["ada", "cyd"]);
    // lastAt reflects the KEPT (earliest, points-contributing) record — the
    // team's total didn't change at cyd's later, redundant correct answer.
    expect(total).toEqual({ points: 20, answered: 1, lastAt: "2026-01-01T00:00:00.000Z", itemIds: ["q1"] });
    const cmds = mocks.upstashPipeline.mock.calls[0][0] as string[][];
    expect(cmds).toEqual([
      ["HGETALL", "ctf:quiz:answers:ada"],
      ["HGETALL", "ctf:quiz:answers:cyd"],
    ]);
  });

  it("keeps the EARLIER record's points when a re-priced question was answered at different prices", async () => {
    // ada answered first at 10 points; cyd answered later at 25 (price went
    // up in between). The team's total must use ada's earlier 10, not cyd's.
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", JSON.stringify({ choices: ["a"], points: 10, at: "2026-01-01T00:00:00.000Z" })] },
      { result: ["q1", JSON.stringify({ choices: ["a"], points: 25, at: "2026-01-02T00:00:00.000Z" })] },
    ]);
    const total = await oneTeam(["ada", "cyd"]);
    expect(total.points).toBe(10);
    expect(total.answered).toBe(1);
  });

  it("sums distinct questions across members without dropping any", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", JSON.stringify({ choices: ["a"], points: 10, at: "2026-01-01T00:00:00.000Z" })] },
      { result: ["q2", JSON.stringify({ choices: ["b"], points: 15, at: "2026-01-01T00:05:00.000Z" })] },
    ]);
    const total = await oneTeam(["ada", "cyd"]);
    expect(total).toEqual({ points: 25, answered: 2, lastAt: "2026-01-01T00:05:00.000Z", itemIds: ["q1", "q2"] });
  });

  it("returns zeros without touching Upstash for a team with no members", async () => {
    const total = await oneTeam([]);
    expect(total).toEqual({ points: 0, answered: 0, lastAt: null, itemIds: [] });
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("returns zeros when no member has answered anything", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }]);
    expect(await oneTeam(["ada", "cyd"])).toEqual({ points: 0, answered: 0, lastAt: null, itemIds: [] });
  });

  it("drops unparseable rows instead of throwing", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["q1", "not json"] }]);
    expect(await oneTeam(["ada"])).toEqual({ points: 0, answered: 0, lastAt: null, itemIds: [] });
  });
});

describe("getTeamQuizTotalsBatch", () => {
  const answer = (points: number, at: string) => JSON.stringify({ choices: ["a"], points, at });

  it("issues ONE pipeline for every team on the board, not one per team", async () => {
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", answer(10, "2026-01-01T00:00:00.000Z")] },
      { result: ["q2", answer(15, "2026-01-01T01:00:00.000Z")] },
      { result: ["q3", answer(20, "2026-01-01T02:00:00.000Z")] },
      { result: [] },
    ]);

    const totals = await getTeamQuizTotalsBatch([
      ["ada", "cyd"],
      ["bob", "eve"],
    ]);

    // The whole point: one round trip, carrying one HGETALL per member.
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.upstashPipeline.mock.calls[0][0]).toEqual([
      ["HGETALL", "ctf:quiz:answers:ada"],
      ["HGETALL", "ctf:quiz:answers:cyd"],
      ["HGETALL", "ctf:quiz:answers:bob"],
      ["HGETALL", "ctf:quiz:answers:eve"],
    ]);
    // Replies partitioned back to the right team, in input order.
    expect(totals).toEqual([
      { points: 25, answered: 2, lastAt: "2026-01-01T01:00:00.000Z", itemIds: ["q1", "q2"] },
      { points: 20, answered: 1, lastAt: "2026-01-01T02:00:00.000Z", itemIds: ["q3"] },
    ]);
  });

  it("keeps the union-by-question dedupe per team — a question two teammates answered still counts once, at the earliest answer's points", async () => {
    // Same invariant the single-team form is held to, proven again on the
    // batched path so the round-trip optimisation can't quietly change it.
    mocks.upstashPipeline.mockResolvedValue([
      { result: ["q1", answer(10, "2026-01-01T00:00:00.000Z")] },
      { result: ["q1", answer(25, "2026-01-02T00:00:00.000Z")] },
    ]);

    const [red] = await getTeamQuizTotalsBatch([["ada", "cyd"]]);
    expect(red).toEqual({ points: 10, answered: 1, lastAt: "2026-01-01T00:00:00.000Z", itemIds: ["q1"] });
  });

  it("fetches a member shared by two teams once and credits both teams from that one reply", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["q1", answer(10, "2026-01-01T00:00:00.000Z")] }]);

    const totals = await getTeamQuizTotalsBatch([["ada"], ["ada"]]);

    expect(mocks.upstashPipeline.mock.calls[0][0]).toEqual([["HGETALL", "ctf:quiz:answers:ada"]]);
    expect(totals[0]).toEqual(totals[1]);
    expect(totals[0].points).toBe(10);
  });

  it("returns a zero total per team without touching Upstash when no team has members", async () => {
    expect(await getTeamQuizTotalsBatch([[], []])).toEqual([
      { points: 0, answered: 0, lastAt: null, itemIds: [] },
      { points: 0, answered: 0, lastAt: null, itemIds: [] },
    ]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("returns an empty array for an empty board without touching Upstash", async () => {
    expect(await getTeamQuizTotalsBatch([])).toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("gives a memberless team a zero total while still reading the teams that do have members", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["q1", answer(10, "2026-01-01T00:00:00.000Z")] }]);
    const totals = await getTeamQuizTotalsBatch([[], ["ada"]]);
    expect(totals[0]).toEqual({ points: 0, answered: 0, lastAt: null, itemIds: [] });
    expect(totals[1].points).toBe(10);
  });
});

// --- Bulk import / export ------------------------------------------------
//
// `importBundle` trusts its input completely (validation lives in
// quiz-io.ts's `parseBundle`, in one place, so the form path and the bulk
// path cannot grow different rules), so these tests are about what it
// WRITES, not what it rejects.

const bundleQuestion = {
  id: "q1",
  prompt: "  Which header?  ",
  type: "single" as const,
  choices: [
    { id: "b", label: "B" },
    { id: "a", label: "A" },
  ],
  points: 10,
  order: 0,
  correct: ["b", "a", "b"],
};

/** Queues the reply for `importBundle`'s leading membership read (HKEYS),
 *  then the write pipeline's own all-clear. */
function queueImport(existingIds: string[]) {
  mocks.upstashPipeline
    .mockResolvedValueOnce([{ result: existingIds }])
    .mockResolvedValueOnce([{ result: 1 }, { result: 1 }]);
}

describe("importBundle", () => {
  it("writes each question and its key, and reports created vs updated", async () => {
    queueImport(["q1"]);
    const summary = await importBundle({
      version: 1,
      questions: [bundleQuestion, { ...bundleQuestion, id: "q2", correct: ["a"] }],
    });
    expect(summary).toEqual({ created: 1, updated: 1 });
  });

  // A question stored without its key is exactly the state that makes a
  // question permanently unanswerable, so the two hashes must never be
  // observably out of step partway through a bulk write.
  it("writes every question and every key in ONE pipeline call", async () => {
    queueImport([]);
    await importBundle({ version: 1, questions: [bundleQuestion, { ...bundleQuestion, id: "q2" }] });
    const writeCommands = mocks.upstashPipeline.mock.calls[1][0];
    expect(writeCommands).toHaveLength(4); // 2 questions x (question + key)
    expect(writeCommands.filter((c: string[]) => c[1] === "ctf:quiz:key")).toHaveLength(2);
  });

  // Both mirror `upsertQuestion`, so a bundle-authored row lands
  // byte-identical to a form-authored one — and the canonicalization is load
  // bearing: GRADE_SCRIPT's string-compare stands in for a set-compare only
  // while both sides canonicalize the same way.
  it("trims the prompt and canonicalizes the correct set, exactly as upsertQuestion does", async () => {
    queueImport([]);
    await importBundle({ version: 1, questions: [bundleQuestion] });
    const [questionCmd, keyCmd] = mocks.upstashPipeline.mock.calls[1][0];
    expect(JSON.parse(questionCmd[3]).prompt).toBe("Which header?");
    expect(JSON.parse(keyCmd[3])).toEqual(["a", "b"]); // deduped and sorted
  });

  // The reason import is safe to run against a live quiz mid-event.
  it("never issues a delete, even for questions the bundle omits", async () => {
    queueImport(["q1", "q2", "q3"]);
    await importBundle({ version: 1, questions: [bundleQuestion] });
    expect(JSON.stringify(mocks.upstashPipeline.mock.calls)).not.toContain("HDEL");
  });

  it("refuses to write anything when the membership read itself failed — a failed HKEYS must not report every row created (#261)", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH Authentication required." }]);
    await expect(importBundle({ version: 1, questions: [bundleQuestion] })).rejects.toThrow(/NOAUTH/);
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed write rather than reporting a successful import", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: [] }])
      .mockResolvedValueOnce([{ result: 1 }, { error: "WRONGTYPE" }]);
    await expect(importBundle({ version: 1, questions: [bundleQuestion] })).rejects.toThrow(/WRONGTYPE/);
  });
});

describe("exportBundle", () => {
  it("emits the bank with each question's correct set alongside it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          "q1",
          JSON.stringify({ id: "q1", prompt: "A?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 }),
        ],
      },
      { result: ["q1", JSON.stringify(["a"])] },
    ]);
    const bundle = await exportBundle();
    expect(bundle.version).toBe(1);
    expect(bundle.questions).toEqual([
      { id: "q1", prompt: "A?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1, correct: ["a"] },
    ]);
  });

  // What makes an export usable as a backup: feeding it straight back in
  // must parse, and must report every row as an update rather than a
  // duplicate creation.
  it("round-trips: an export parses and re-imports as pure updates", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          "q1",
          JSON.stringify({ id: "q1", prompt: "A?", type: "single", choices: [{ id: "a", label: "A" }], points: 5, order: 1 }),
        ],
      },
      { result: ["q1", JSON.stringify(["a"])] },
    ]);
    const bundle = await exportBundle();

    const reparsed = parseBundle(serializeBundle(bundle));
    if (!reparsed.ok) throw new Error(`export failed its own validator: ${JSON.stringify(reparsed.errors)}`);

    queueImport(["q1"]);
    expect(await importBundle(reparsed.bundle)).toEqual({ created: 0, updated: 1 });
  });
});
