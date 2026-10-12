// Authoring rules for ai challenges. The two that are NEW (no classic
// equivalent) get the most attention: a launch template must carry the
// {token} placeholder, and every challenge must end up with a signing key —
// minted on create, preserved on edit, replaced only by an explicit rotate.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", async () => ({
  upstashEval: mocks.upstashEval,
  upstashPipeline: mocks.upstashPipeline,
  assertPipelineOk: (await vi.importActual<typeof import("@/lib/upstash")>("@/lib/upstash")).assertPipelineOk,
}));

import {
  AiValidationError,
  clearAiChallenges,
  deleteAiChallenge,
  rotateAiSigningKey,
  renameAiCategory,
  setAiCategories,
  upsertAiChallenge,
  type AiChallenge,
} from "@/lib/ai-store";
import {
  CATEGORY_WRITE_ATTEMPTS,
  CategoryConflictError,
  RENAME_CATEGORY_SCRIPT,
  SET_CATEGORIES_SCRIPT,
} from "@/lib/category-cas";

const pipelineCalls = (): (string | number)[][][] =>
  mocks.upstashPipeline.mock.calls.map((call) => call[0] as (string | number)[][]);

/** Next reply: `GET ctf:ai:categories` — upsert reads the list before writing. */
function categoriesReply(names: string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(names) }]);
}
/** Next reply: `HSETNX ctf:ai:signkey <id> <candidate>` followed by
 *  `HGET ctf:ai:signkey <id>`, in ONE pipeline — the atomic mint-or-preserve.
 *  `hgetResult` is the value every racer converges on: it is what actually
 *  ended up persisted, regardless of whether THIS call's own HSETNX planted
 *  it or lost to a concurrent one. The HSETNX reply itself is never inspected
 *  by the code (only the follow-up HGET is), so its value here is a
 *  placeholder.
 *
 *  `null` means "this call's own HSETNX won" — a fresh create. The HGET then
 *  ECHOES the candidate the code just planted, because that is what a real
 *  pipeline does: both commands run against the same row, in order. Replying
 *  `null` there would model a Redis that forgets a write it just accepted, and
 *  a fixture like that would let a caller-side fallback pass for correct. */
function signingKeyReply(hgetResult: string | null) {
  mocks.upstashPipeline.mockImplementationOnce(async (commands: (string | number)[][]) => [
    { result: 1 },
    { result: hgetResult ?? String(commands[0][3]) },
  ]);
}
function writeReply(n: number) {
  mocks.upstashPipeline.mockResolvedValueOnce(Array.from({ length: n }, () => ({ result: 1 })));
}

const CHALLENGE: AiChallenge = {
  id: "prompt-leak-ab12cd",
  title: "Prompt leak",
  category: "Injection",
  description: "Make it spill.",
  points: 300,
  order: 1,
  mode: "both",
  urlTemplate: "https://game.example.com/play?t={token}",
};

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashEval.mockReset();
});

describe("upsertAiChallenge", () => {
  it("mints a signing key on create and writes every hash in one pipeline", async () => {
    categoriesReply(["Injection"]);
    signingKeyReply(null);
    writeReply(4);

    const row = await upsertAiChallenge(CHALLENGE, { flag: "CTF{leak}" });

    expect(row.challenge).toEqual(CHALLENGE);
    expect(row.flag).toBe("CTF{leak}");
    expect(row.signingKey.startsWith("aik_")).toBe(true);

    // The key is NOT written here. `HSETNX` in the previous pipeline already
    // planted it; a second, later write of a value read before it is what
    // `rotateAiSigningKey` would lose a race to (see the rotate-race test).
    const writes = pipelineCalls()[2];
    expect(writes).toEqual([
      ["HSET", "ctf:ai:challenges", CHALLENGE.id, JSON.stringify(CHALLENGE)],
      ["HSET", "ctf:ai:flag", CHALLENGE.id, "CTF{leak}"],
      ["HSET", "ctf:ai:flagnorm", CHALLENGE.id, "ctf{leak}"],
      ["HDEL", "ctf:ai:hints", CHALLENGE.id],
    ]);
    expect(JSON.stringify(writes)).not.toContain("ctf:ai:signkey");
  });

  it("keeps the existing key on edit — an edit that rotated silently would break a live integration", async () => {
    categoriesReply(["Injection"]);
    signingKeyReply("aik_existing");
    writeReply(4);

    const row = await upsertAiChallenge({ ...CHALLENGE, title: "Renamed" }, { flag: "CTF{leak}" });

    expect(row.signingKey).toBe("aik_existing");
    // The preserved key is what the caller is TOLD, not something re-asserted
    // against Redis — the row already holds it.
    expect(JSON.stringify(pipelineCalls()[2])).not.toContain("ctf:ai:signkey");
  });

  it("stores an event-only challenge with no flag at all", async () => {
    categoriesReply(["Injection"]);
    signingKeyReply(null);
    writeReply(4);

    const row = await upsertAiChallenge({ ...CHALLENGE, mode: "event" }, {});

    expect(row.flag).toBe("");
    const writes = pipelineCalls()[2];
    expect(writes).toContainEqual(["HDEL", "ctf:ai:flag", CHALLENGE.id]);
    expect(writes).toContainEqual(["HDEL", "ctf:ai:flagnorm", CHALLENGE.id]);
  });

  it("requires a flag when the mode grades one", async () => {
    categoriesReply(["Injection"]);
    await expect(upsertAiChallenge({ ...CHALLENGE, mode: "flag" }, {})).rejects.toThrow(AiValidationError);
  });

  it("rejects a template with no {token} placeholder", async () => {
    categoriesReply(["Injection"]);
    await expect(
      upsertAiChallenge({ ...CHALLENGE, urlTemplate: "https://game.example.com/play" }, { flag: "CTF{leak}" }),
    ).rejects.toThrow(/\{token\}/);
  });

  it("rejects an unknown category, a bad id, and non-integer or over-cap points", async () => {
    categoriesReply(["Injection"]);
    await expect(upsertAiChallenge({ ...CHALLENGE, category: "Nope" }, { flag: "f" })).rejects.toThrow(
      AiValidationError,
    );
    await expect(upsertAiChallenge({ ...CHALLENGE, id: "bad id!" }, { flag: "f" })).rejects.toThrow(
      AiValidationError,
    );
    categoriesReply(["Injection"]);
    await expect(upsertAiChallenge({ ...CHALLENGE, points: 1.5 }, { flag: "f" })).rejects.toThrow(
      AiValidationError,
    );
    categoriesReply(["Injection"]);
    await expect(upsertAiChallenge({ ...CHALLENGE, points: 1e21 }, { flag: "f" })).rejects.toThrow(
      AiValidationError,
    );
  });

  it("rejects a non-integer order — a stored NaN would make the challenge invisible while its signing key stayed live", async () => {
    // `parseChallenge` drops any record whose `order` is not a number, and
    // `JSON.stringify(NaN)` writes `null`. Persisting one would produce a
    // challenge that neither lister returns (so nobody can see or edit it)
    // whose `ctf:ai:flag` and `ctf:ai:signkey` rows are still live and which
    // AWARD_SCRIPT still grades. Refuse it on the way in.
    categoriesReply(["Injection"]);
    await expect(upsertAiChallenge({ ...CHALLENGE, order: Number.NaN }, { flag: "f" })).rejects.toThrow(
      AiValidationError,
    );
    categoriesReply(["Injection"]);
    await expect(upsertAiChallenge({ ...CHALLENGE, order: 1.5 }, { flag: "f" })).rejects.toThrow(
      AiValidationError,
    );
    // Nothing was written: the two calls each stopped after their categories read.
    expect(pipelineCalls()).toHaveLength(2);
  });

  it("stores the case-sensitive comparison form when the challenge asks for it", async () => {
    categoriesReply(["Injection"]);
    signingKeyReply(null);
    writeReply(4);

    await upsertAiChallenge({ ...CHALLENGE, caseSensitive: true }, { flag: "CTF{Leak}" });

    expect(pipelineCalls()[2]).toContainEqual(["HSET", "ctf:ai:flagnorm", CHALLENGE.id, "CTF{Leak}"]);
  });

  it("converges on the persisted key when two mints race — the loser must return what was actually saved, not its own discarded candidate", async () => {
    categoriesReply(["Injection"]);
    // HSETNX loses this race (another caller's mint already won); HGET
    // reports the key that ACTUALLY ended up persisted. The candidate this
    // call generated internally must never surface anywhere.
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 0 }, { result: "aik_winner" }]);
    writeReply(4);

    const row = await upsertAiChallenge(CHALLENGE, { flag: "CTF{leak}" });

    expect(row.signingKey).toBe("aik_winner");
    expect(JSON.stringify(pipelineCalls()[2])).not.toContain("ctf:ai:signkey");
  });

  it("refuses rather than guessing when the effective key cannot be read — returning the discarded candidate would hand the organizer a key the box never accepted", async () => {
    categoriesReply(["Injection"]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { error: "READONLY" }]);

    await expect(upsertAiChallenge(CHALLENGE, { flag: "CTF{leak}" })).rejects.toThrow(/HGET/);
    // And it stops there: no record is written against a key nobody can name.
    expect(pipelineCalls()).toHaveLength(2);

    // Same refusal when the reply is merely unusable rather than an error.
    categoriesReply(["Injection"]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: null }]);
    await expect(upsertAiChallenge(CHALLENGE, { flag: "CTF{leak}" })).rejects.toThrow(/signing key/);
    expect(pipelineCalls()).toHaveLength(4);
  });

  it("does not resurrect a key that rotated between the mint pipeline and the write pipeline", async () => {
    // The whole point of dropping the trailing `HSET ctf:ai:signkey` from the
    // write pipeline. `rotateAiSigningKey` commits in the window between
    // upsert's two round trips; a write pipeline that re-asserted the key it
    // read first would put the REVOKED key back, silently, and the organizer
    // would keep grading with a key they had explicitly retired.
    const signkeys = new Map<string, string>([[CHALLENGE.id, "aik_preRotation"]]);
    let rotated = false;

    mocks.upstashPipeline.mockImplementation(async (commands: (string | number)[][]) =>
      commands.map((cmd) => {
        const [op, key, field, value] = cmd.map(String);
        if (op === "GET" && key === "ctf:ai:categories") return { result: JSON.stringify(["Injection"]) };
        if (key !== "ctf:ai:signkey") return { result: 1 };
        if (op === "HSETNX") return { result: signkeys.has(field) ? 0 : (signkeys.set(field, value), 1) };
        if (op === "HSET") return { result: (signkeys.set(field, value), 1) };
        if (op === "HGET") {
          const current = signkeys.get(field) ?? null;
          // The rotate lands the instant upsert has finished reading. Anything
          // upsert writes after this point is writing a stale value.
          if (!rotated) {
            rotated = true;
            signkeys.set(field, "aik_rotated");
          }
          return { result: current };
        }
        return { result: 1 };
      }),
    );

    await upsertAiChallenge(CHALLENGE, { flag: "CTF{leak}" });

    expect(signkeys.get(CHALLENGE.id)).toBe("aik_rotated");
  });
});

describe("rotateAiSigningKey", () => {
  it("replaces the key and returns the new one", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(CHALLENGE) }]);
    writeReply(1);

    const key = await rotateAiSigningKey(CHALLENGE.id);

    expect(key.startsWith("aik_")).toBe(true);
    expect(pipelineCalls()[1]).toEqual([["HSET", "ctf:ai:signkey", CHALLENGE.id, key]]);
  });

  it("refuses to mint a key for a challenge that does not exist", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    await expect(rotateAiSigningKey("ghost-000000")).rejects.toThrow(AiValidationError);
    expect(pipelineCalls()).toHaveLength(1);
  });
});

describe("deleteAiChallenge", () => {
  it("removes the record and every secret that hangs off it — and NO aggregate", async () => {
    writeReply(5);
    await deleteAiChallenge(CHALLENGE.id);
    // Exactly classic's five-key delete contract. `ctf:ai:solvecount` is
    // deliberately absent: recreating the id (which upsertAiChallenge allows)
    // would restart the counter at 0 while every prior solver still holds a
    // solve row, and AWARD_SCRIPT's already-solved guard means none of them can
    // ever re-increment it — a board permanently reading "0 solvers" on a
    // challenge dozens of people solved. Un-awarding is the master reset's job.
    expect(pipelineCalls()[0]).toEqual([
      ["HDEL", "ctf:ai:challenges", CHALLENGE.id],
      ["HDEL", "ctf:ai:flag", CHALLENGE.id],
      ["HDEL", "ctf:ai:flagnorm", CHALLENGE.id],
      ["HDEL", "ctf:ai:hints", CHALLENGE.id],
      ["HDEL", "ctf:ai:signkey", CHALLENGE.id],
    ]);
    expect(JSON.stringify(pipelineCalls()[0])).not.toContain("ctf:ai:solvecount");
    expect(JSON.stringify(pipelineCalls()[0])).not.toContain("ctf:ai:points");
    expect(JSON.stringify(pipelineCalls()[0])).not.toContain("ctf:ai:solved");
  });

  it("surfaces a failed delete instead of leaving a live key behind", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "boom" }]);
    await expect(deleteAiChallenge(CHALLENGE.id)).rejects.toThrow(/boom/);
  });
});

describe("clearAiChallenges", () => {
  it("wipes every content key in one pipeline", async () => {
    writeReply(7);
    await clearAiChallenges();
    expect(pipelineCalls()[0]).toEqual([
      ["DEL", "ctf:ai:challenges"],
      ["DEL", "ctf:ai:flag"],
      ["DEL", "ctf:ai:flagnorm"],
      ["DEL", "ctf:ai:hints"],
      ["DEL", "ctf:ai:signkey"],
      ["DEL", "ctf:ai:categories"],
      ["DEL", "ctf:ai:solvecount"],
    ]);
  });

  it("surfaces a failed clear instead of leaving stale content behind", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "boom" }]);
    await expect(clearAiChallenges()).rejects.toThrow(/boom/);
  });
});

describe("setAiCategories", () => {
  it("trims, dedupes and stores the organizer's order through a guarded write", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: JSON.stringify(["Injection"]) }])
      .mockResolvedValueOnce([{ result: 1 }]);
    expect(await setAiCategories([" Injection ", "Jailbreak", "Injection"], ["Injection"])).toEqual([
      "Injection",
      "Jailbreak",
    ]);
    expect(pipelineCalls()[0]).toEqual([["GET", "ctf:ai:categories"]]);
    expect(pipelineCalls()[1]).toEqual([
      [
        "EVAL",
        SET_CATEGORIES_SCRIPT,
        1,
        "ctf:ai:categories",
        "1",
        JSON.stringify(["Injection"]),
        JSON.stringify(["Injection", "Jailbreak"]),
      ],
    ]);
  });

  it("rejects an over-long name and an over-long list", async () => {
    await expect(setAiCategories(["x".repeat(65)], [])).rejects.toThrow(AiValidationError);
    await expect(setAiCategories(Array.from({ length: 51 }, (_, i) => `c${i}`), [])).rejects.toThrow(
      AiValidationError,
    );
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("refuses with a conflict, writing nothing, when another organizer changed the list", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Injection", "Jailbreak"]) }]);
    await expect(setAiCategories(["Injection", "Recon"], ["Injection"])).rejects.toBeInstanceOf(
      CategoryConflictError,
    );
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("refuses with a conflict when the guarded write keeps losing the race", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands: (string | number)[][]) =>
      commands[0][0] === "GET" ? [{ result: JSON.stringify(["Injection"]) }] : [{ result: 0 }],
    );
    await expect(setAiCategories(["Injection", "Recon"], ["Injection"])).rejects.toBeInstanceOf(
      CategoryConflictError,
    );
    expect(pipelineCalls().filter((c) => c[0][0] === "EVAL")).toHaveLength(CATEGORY_WRITE_ATTEMPTS);
  });
});

// A rename must refuse a case-insensitive clash (the panel forbids one, and two
// casings would split a category's challenges across two headings), and it
// must fail closed when the challenge read fails rather than rewriting the list
// while moving nothing.
describe("renameAiCategory", () => {
  const challenge = (id: string, category: string) => ({
    id,
    title: `T ${id}`,
    category,
    description: "",
    points: 100,
    order: 1,
    mode: "flag",
    urlTemplate: "https://example.test/{token}",
  });

  function readReply(categories: string[], challenges: ReturnType<typeof challenge>[]) {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: JSON.stringify(categories) },
      { result: challenges.flatMap((c) => [c.id, JSON.stringify(c)]) },
    ]);
  }
  const evalCalls = () => pipelineCalls().filter((cmds) => cmds[0][0] === "EVAL");

  it("moves the category's challenges and rewrites the list in one script", async () => {
    mocks.upstashPipeline.mockReset();
    readReply(["Jailbreakk", "Injection"], [challenge("a", "Jailbreakk")]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);

    expect(await renameAiCategory("Jailbreakk", "Jailbreak")).toEqual({
      categories: ["Jailbreak", "Injection"],
      moved: 1,
    });
    expect(pipelineCalls()[0]).toEqual([["GET", "ctf:ai:categories"], ["HGETALL", "ctf:ai:challenges"]]);
    const [cmd] = evalCalls()[0];
    expect(cmd.slice(0, 10)).toEqual([
      "EVAL",
      RENAME_CATEGORY_SCRIPT,
      2,
      "ctf:ai:categories",
      "ctf:ai:challenges",
      "1",
      JSON.stringify(["Jailbreakk", "Injection"]),
      JSON.stringify(["Jailbreak", "Injection"]),
      "Jailbreakk",
      "a",
    ]);
    expect(JSON.parse(String(cmd[11]))).toEqual(challenge("a", "Jailbreak"));
  });

  it("refuses a name another category already holds, ignoring case", async () => {
    // A case-sensitive comparison, mirroring setAiCategories' own dedupe, would
    // let a rename store ["Injection", "injection"] — which the panel refuses
    // and which would split one category in two.
    mocks.upstashPipeline.mockReset();
    readReply(["Injection", "Jailbreak"], []);
    await expect(renameAiCategory("Jailbreak", "injection")).rejects.toBeInstanceOf(AiValidationError);
    expect(evalCalls()).toHaveLength(0);
  });

  it("still allows a change of spelling on the entry being renamed", async () => {
    mocks.upstashPipeline.mockReset();
    readReply(["injection"], []);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);

    expect((await renameAiCategory("injection", "Injection")).categories).toEqual(["Injection"]);
  });

  it("moves the challenges filed under the STORED spelling, whatever casing the request used", async () => {
    // Challenges carry the list's exact spelling (upsert refuses any other), so
    // matching on the request's casing would rewrite the list and leave them
    // under a name it no longer holds.
    mocks.upstashPipeline.mockReset();
    readReply(["Jailbreak"], [challenge("a", "Jailbreak")]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);

    expect(await renameAiCategory("jailbreak", "Jailbreaks")).toEqual({ categories: ["Jailbreaks"], moved: 1 });
    expect(evalCalls()[0][0][8]).toBe("Jailbreak");
  });

  it("does NOT write anything when the challenge read failed", async () => {
    // A failed HGETALL read as an empty hash looks like "nothing uses this
    // category" — and renaming on top of that orphans every challenge in it.
    mocks.upstashPipeline.mockReset();
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Jailbreak"]) }, { error: "WRONGTYPE" }]);

    await expect(renameAiCategory("Jailbreak", "Jailbreaks")).rejects.toThrow(/WRONGTYPE/);
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("re-plans when the script refuses a stale read, keeping a concurrent add", async () => {
    mocks.upstashPipeline.mockReset();
    readReply(["Jailbreakk"], []);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 0 }]);
    readReply(["Jailbreakk", "Recon"], []);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);

    expect((await renameAiCategory("Jailbreakk", "Jailbreak")).categories).toEqual(["Jailbreak", "Recon"]);
  });

  it("gives up with a conflict after a bounded number of refused attempts", async () => {
    mocks.upstashPipeline.mockReset();
    mocks.upstashPipeline.mockImplementation(async (commands: (string | number)[][]) =>
      commands[0][0] === "GET" ? [{ result: JSON.stringify(["Jailbreak"]) }, { result: [] }] : [{ result: 0 }],
    );
    await expect(renameAiCategory("Jailbreak", "Jailbreaks")).rejects.toBeInstanceOf(CategoryConflictError);
    expect(evalCalls()).toHaveLength(CATEGORY_WRITE_ATTEMPTS);
  });
});
