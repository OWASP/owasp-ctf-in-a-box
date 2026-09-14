import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn(),
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import { seedDemoData, SEED_CATEGORIES_SCRIPT } from "@/lib/admin-store";
import { upsertQuestion } from "@/lib/quiz-store";
import { normalizeFlag, flagComparisonForm, CLASSIC_CATEGORIES_MAX } from "@/lib/classic-keys";
import { AI_CATEGORIES_MAX } from "@/lib/ai-keys";
import {
  DEMO_CONTESTANTS,
  DEMO_TEAMS,
  DEMO_QUESTIONS,
  DEMO_QUIZ_ANSWERS,
  DEMO_CHALLENGES,
  DEMO_CLASSIC_CATEGORIES,
  DEMO_CLASSIC_SOLVES,
  DEMO_AI_CHALLENGES,
  DEMO_AI_CATEGORIES,
  DEMO_AI_SOLVES,
  DEMO_SPONSORS,
} from "@/lib/demo-fixture";

/** The settings-read shape `getAdminSettings` decodes `enabledModules` from —
 *  a comma-joined id list on the ONE hash the seed's schedule clamp and its
 *  module gates now share a single read of (issue #386). Call this before
 *  `seedDemoData` to control which modules the NEXT read sees; it queues onto
 *  `upstashPipeline` with `mockResolvedValueOnce`, so it must be the very next
 *  call — which the settings read always is, since it happens first. */
function mockEnabledModules(ids: readonly string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["enabledModules", ids.join(",")] }]);
}

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  // Answers BOTH pipelines the seed now runs: the settings read (HGETALL,
  // which the clamp consumes — empty hash = no schedule = unclamped — and
  // which the module gates below now also read `enabledModules` off) and the
  // write batch (whose return is unused).
  //
  // ai is deliberately left OFF by default (only secure-development + quiz +
  // classic on), so the large existing block of assertions below stays
  // byte-for-byte identical to pre-ai behavior; ai gets its own describe
  // block with its own mock. secure-development stays on by default too —
  // most of this file's assertions read `ctf:solves:<target>` rows, which
  // only exist when it is live (issue #386's carry-forward gate); the one
  // no-secure-development case gets its own dedicated test below.
  mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", "secure-development,quiz,classic"] }]);
});


type Cmd = (string | number)[];

/** The category script's arguments for one module, unpacked from the EVAL the
 *  seed queued: KEYS are the categories and challenges hashes, ARGV is the
 *  fixture's category list, the cap, then one JSON record per challenge. */
function scriptArgs(cmds: Cmd[], challengesKey: string) {
  const evalCmd = cmds.find((c) => c[0] === "EVAL" && c[4] === challengesKey);
  expect(evalCmd, `no category script for ${challengesKey}`).toBeTruthy();
  return {
    categoriesKey: String(evalCmd![3]),
    fixtureCategories: JSON.parse(String(evalCmd![5])) as string[],
    max: Number(evalCmd![6]),
    records: evalCmd!.slice(7).map((v) => JSON.parse(String(v))) as Record<string, unknown>[],
  };
}

/** Just the challenge records the seed queued for one module. */
function seededRecords(cmds: Cmd[], challengesKey: string): Record<string, unknown>[] {
  return scriptArgs(cmds, challengesKey).records;
}

describe("seedDemoData", () => {
  it("writes solves, teams, membership + a seed audit line in one pipeline", async () => {
    const out = await seedDemoData("alice");

    const expectedSolves = DEMO_CONTESTANTS.reduce(
      (n, c) => n + Object.values(c.solves).reduce((m, ids) => m + ids.length, 0),
      0,
    );
    expect(out).toEqual({
      contestants: DEMO_CONTESTANTS.length,
      teams: DEMO_TEAMS.length,
      solves: expectedSolves,
      sponsors: DEMO_SPONSORS.length,
    });

    // Reads first — the schedule (for the timestamp clamp) and each enabled
    // module's category list (for the union) — then EVERY write in one batch.
    // Asserted as a shape rather than a call count, so enabling another module
    // adds a read without editing a number here: each earlier call is a single
    // read command, and the last call is the write batch.
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const read of calls.slice(0, -1)) {
      expect(read).toHaveLength(1);
      expect(["GET", "HGETALL"]).toContain(read[0][0]);
    }
    const cmds = calls.at(-1)!;
    expect(cmds.length).toBeGreaterThan(1);

    // one HSET per solve, into ctf:solves:<target>
    const solveCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:solves:"));
    expect(solveCmds.length).toBe(expectedSolves);
    // real challenge-id fields shaped "<login>:<id>"
    expect(String(solveCmds[0][2])).toMatch(/^[a-z0-9-]+:[a-z0-9-]+$/);

    // a team hash + a members SADD per team
    expect(cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:team:")).length).toBe(DEMO_TEAMS.length);
    expect(cmds.filter((c) => c[0] === "SADD").length).toBe(DEMO_TEAMS.length);

    // audit line records the seed
    const lpush = cmds.find((c) => c[0] === "LPUSH");
    expect(lpush).toBeTruthy();
    expect(JSON.parse(String(lpush![2]))).toMatchObject({ by: "alice", action: "seed" });

    // sponsors — a platform feature, so always seeded regardless of modules
    const sponsorCmds = cmds.filter((c) => c[1] === "ctf:sponsors");
    expect(sponsorCmds.length).toBe(DEMO_SPONSORS.length);
    const firstSponsor = JSON.parse(String(sponsorCmds[0][3])) as {
      logo: { type: string; bytes: number; w: number; h: number; etag: string } | null;
    };
    // Every demo sponsor carries a real logo now, with bytes/etag DERIVED
    // from the fixture's own base64 data — never hand-carried, so the two
    // cannot silently drift apart.
    expect(firstSponsor.logo).toMatchObject({ type: "image/png", w: 160, h: 56 });
    expect(firstSponsor.logo?.etag).toMatch(/^[0-9a-f]{16}$/);

    const logoBlobCmds = cmds.filter((c) => c[1] === "ctf:sponsors:logo");
    expect(logoBlobCmds.length).toBe(DEMO_SPONSORS.length);
  });

  // CodeRabbit round 2, finding F1: the settings read now also decides WHICH
  // modules get demo rows, so it gates a write — it must fail closed. A
  // transient read error used to be swallowed (`.catch(() => null)`) and
  // seed the deployment-default module set regardless of what the organizer
  // actually enabled; it must instead abort the seed with no write issued.
  it("aborts the seed when the settings read fails, instead of seeding the default module set", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH Authentication required." }]);

    await expect(seedDemoData("alice")).rejects.toThrow("NOAUTH Authentication required.");
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  // CodeRabbit round 1, finding E: the ctf:solves:<target> writes (and the
  // `solves` count derived from them) used to run unconditionally, off the
  // fixture alone — showing solves for a module this event isn't even
  // serving. Gated on `live.has("secure-development")`, same as quiz/classic/
  // ai below.
  it("skips secure-development's demo solves entirely when it is not live", async () => {
    mockEnabledModules(["quiz"]);
    const out = await seedDemoData("alice");
    expect(out.solves).toBe(0);

    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    const solveCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:solves:"));
    expect(solveCmds.length).toBe(0);

    const lpush = cmds.find((c) => c[0] === "LPUSH");
    expect(JSON.parse(String(lpush![2]))).toMatchObject({ solves: 0 });
  });

  it("spreads EACH contestant's solves across the window so lines interleave", async () => {
    await seedDemoData("bob");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    // pick the contestant with the most solves and check their own timestamps
    // span most of the ~6h window (not a narrow per-contestant block).
    const top = [...DEMO_CONTESTANTS].sort(
      (a, b) =>
        Object.values(b.solves).reduce((m, i) => m + i.length, 0) -
        Object.values(a.solves).reduce((m, i) => m + i.length, 0),
    )[0];
    const times = cmds
      .filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:solves:") && String(c[2]).startsWith(`${top.login}:`))
      .map((c) => Date.parse(String(c[3])))
      .sort((a, b) => a - b);
    const windowMs = 6 * 60 * 60 * 1000;
    expect(times[times.length - 1] - times[0]).toBeGreaterThan(windowMs * 0.5);
  });

  // The clamp: seeded history must agree with the phase line. A seed clicked
  // two hours into a scheduled event must not stamp solves before "scoring
  // opens" — that put a full race on the chart dated before the schedule
  // said scoring existed.
  it("clamps every seeded timestamp inside the scoring window when one is set", async () => {
    const startMs = Date.now() - 2 * 60 * 60 * 1000; // opened 2h ago
    const endMs = Date.now() + 24 * 60 * 60 * 1000; // closes tomorrow
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          "scoringStartsAt",
          new Date(startMs).toISOString(),
          "scoringEndsAt",
          new Date(endMs).toISOString(),
          // Same default as the outer beforeEach — this override replaces the
          // WHOLE settings read, so it has to restate enabledModules too, or
          // the fallback default (empty, no SCORE_IMAGE in the test env)
          // would silently drop quiz out of what this test exercises.
          "enabledModules",
          "secure-development,quiz,classic",
        ],
      },
    ]);
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    const stamps = cmds
      .filter(
        (c) =>
          c[0] === "HSET" &&
          (String(c[1]).startsWith("ctf:solves:") || String(c[1]).startsWith("ctf:quiz:answers:")),
      )
      .map((c) => Date.parse(String(c[3]).startsWith("{") ? (JSON.parse(String(c[3])) as { at: string }).at : String(c[3])));
    expect(stamps.length).toBeGreaterThan(0);
    for (const t of stamps) {
      expect(t).toBeGreaterThanOrEqual(startMs);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
  });

  it("falls back to the unclamped window when the schedule is entirely in the future", async () => {
    const startMs = Date.now() + 60 * 60 * 1000; // opens in an hour
    mocks.upstashPipeline.mockResolvedValueOnce([
      {
        result: [
          "scoringStartsAt",
          new Date(startMs).toISOString(),
          "enabledModules",
          "secure-development,quiz,classic",
        ],
      },
    ]);
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    const stamps = cmds
      .filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:solves:"))
      .map((c) => Date.parse(String(c[3])));
    expect(stamps.length).toBeGreaterThan(0);
    // Never future-dated — the fallback is yesterday's now-minus-6h window.
    for (const t of stamps) expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("puts every demo contestant on a team (no soloists left off the team board)", () => {
    const teamed = new Set(DEMO_TEAMS.flatMap((t) => t.members));
    for (const c of DEMO_CONTESTANTS) expect(teamed.has(c.login)).toBe(true);
    // and every team's captain is one of its members
    for (const t of DEMO_TEAMS) expect(t.members).toContain(t.captain);
  });

  it("seeds demo questions and answers so DEMO_MODE shows two scoring modules", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    // a mix of single and multi questions
    expect(DEMO_QUESTIONS.some((q) => q.type === "single")).toBe(true);
    expect(DEMO_QUESTIONS.some((q) => q.type === "multi")).toBe(true);
    expect(DEMO_QUESTIONS.length).toBeGreaterThanOrEqual(5);

    // one HSET per question into the public questions hash, with NO `correct`
    // field leaked into the stored value
    const questionCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:quiz:questions");
    expect(questionCmds.length).toBe(DEMO_QUESTIONS.length);
    for (const c of questionCmds) {
      const stored = JSON.parse(String(c[3]));
      expect(stored.correct).toBeUndefined();
    }

    // one HSET per question into the answer-key hash, each a sorted, deduped
    // JSON array of correct choice ids — proven by driving quiz-store's OWN
    // upsertQuestion with the same `correct` set and asserting the seed's
    // stored value is byte-identical to what upsertQuestion itself writes.
    // This must fail if quiz-store's canonicalization ever changes and the
    // seed doesn't follow, rather than the test re-deriving the formula
    // (which would drift in lockstep with a bug instead of catching it).
    const keyCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:quiz:key");
    expect(keyCmds.length).toBe(DEMO_QUESTIONS.length);
    for (const q of DEMO_QUESTIONS) {
      await upsertQuestion(
        { id: q.id, prompt: q.prompt, type: q.type, choices: q.choices, points: q.points, order: q.order },
        q.correct,
      );
      const realCall = mocks.upstashPipeline.mock.calls.at(-1)![0];
      const realKeyCmd = realCall.find((c) => c[0] === "HSET" && c[1] === "ctf:quiz:key")!;

      const seededCmd = keyCmds.find((c) => c[2] === q.id)!;
      expect(seededCmd[3]).toBe(realKeyCmd[3]); // byte-identical to quiz-store's own output

      const stored = JSON.parse(String(seededCmd[3]));
      expect(stored).toEqual([...stored].sort()); // sorted
      expect(new Set(stored).size).toBe(stored.length); // deduped
    }

    // answers are spread across more than one demo contestant, each written
    // into that login's own answers hash
    const answerCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:quiz:answers:"));
    expect(answerCmds.length).toBe(DEMO_QUIZ_ANSWERS.length);
    const logins = new Set(answerCmds.map((c) => String(c[1]).replace("ctf:quiz:answers:", "")));
    expect(logins.size).toBeGreaterThan(1);

    // each stored answer row is well-formed and timestamped inside the same
    // ~6h window as the seeded solves
    const windowMs = 6 * 60 * 60 * 1000;
    for (const c of answerCmds) {
      const row = JSON.parse(String(c[3]));
      expect(Array.isArray(row.choices)).toBe(true);
      expect(typeof row.points).toBe("number");
      const ageMs = Date.now() - Date.parse(row.at);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThanOrEqual(windowMs + 1000);
    }

    // the two aggregate hashes are updated so the leaderboard overlay picks
    // up quiz points for every login that answered something
    const pointsCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:quiz:points");
    const answeredCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:quiz:answered");
    expect(pointsCmds.length).toBe(logins.size);
    expect(answeredCmds.length).toBe(logins.size);
    for (const login of logins) {
      const expectedAnswers = DEMO_QUIZ_ANSWERS.filter((a) => a.login === login);
      const expectedPoints = expectedAnswers.reduce(
        (sum, a) => sum + DEMO_QUESTIONS.find((q) => q.id === a.questionId)!.points,
        0,
      );
      const pointsCmd = pointsCmds.find((c) => c[2] === login)!;
      const answeredCmd = answeredCmds.find((c) => c[2] === login)!;
      expect(Number(pointsCmd[3])).toBe(expectedPoints);
      expect(Number(answeredCmd[3])).toBe(expectedAnswers.length);
    }
  });

  it("does not seed quiz content when quiz is not live", async () => {
    mockEnabledModules(["classic"]);
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:quiz:"))).toBe(false);
  });

  it("seeds classic challenges + both flag hashes, with NO flag in the public record", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    expect(DEMO_CHALLENGES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(DEMO_CHALLENGES.map((c) => c.category)).size).toBeGreaterThanOrEqual(3);

    // one record per challenge for the public challenges hash, with NO flag
    // field anywhere in the stored value. They ride in the category script's
    // ARGV rather than their own HSETs — see SEED_CATEGORIES_SCRIPT — but the
    // secrecy boundary is the same and is asserted the same way.
    const challengeRecords = seededRecords(cmds, "ctf:classic:challenges");
    expect(challengeRecords.length).toBe(DEMO_CHALLENGES.length);
    for (const stored of challengeRecords) {
      expect(stored.flag).toBeUndefined();
      expect(JSON.stringify(stored)).not.toMatch(/ctfbox/i);
    }

    // the authored flag hash holds the flag verbatim
    const flagCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:classic:flag");
    expect(flagCmds.length).toBe(DEMO_CHALLENGES.length);
    for (const dc of DEMO_CHALLENGES) {
      const cmd = flagCmds.find((c) => c[2] === dc.id)!;
      expect(cmd[3]).toBe(dc.flag);
    }

    // the normalized flag hash is EXACTLY normalizeFlag(authored) — proven
    // against classic-keys.ts's own function, never a re-derived formula
    const flagnormCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:classic:flagnorm");
    expect(flagnormCmds.length).toBe(DEMO_CHALLENGES.length);
    for (const dc of DEMO_CHALLENGES) {
      const cmd = flagnormCmds.find((c) => c[2] === dc.id)!;
      expect(cmd[3]).toBe(normalizeFlag(dc.flag));
    }

    // the fixture's categories are handed to the script in display order, and
    // NOTHING writes the key with a bare SET any more (issue #344)
    expect(scriptArgs(cmds, "ctf:classic:challenges").fixtureCategories).toEqual(DEMO_CLASSIC_CATEGORIES);
    expect(cmds.find((c) => c[0] === "SET" && c[1] === "ctf:classic:categories")).toBeUndefined();
  });

  it("seeds classic solves so aggregates agree with the per-login rows and solvecount", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    expect(DEMO_CLASSIC_SOLVES.length).toBeGreaterThan(0);

    // one HSET per solve into that login's own solves hash
    const solveCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:classic:solves:"));
    expect(solveCmds.length).toBe(DEMO_CLASSIC_SOLVES.length);
    const logins = new Set(solveCmds.map((c) => String(c[1]).replace("ctf:classic:solves:", "")));
    expect(logins.size).toBeGreaterThan(1);

    // each stored solve row is well-formed and timestamped inside the same
    // ~6h window as the other seeded activity
    const windowMs = 6 * 60 * 60 * 1000;
    for (const c of solveCmds) {
      const row = JSON.parse(String(c[3]));
      expect(typeof row.points).toBe("number");
      const ageMs = Date.now() - Date.parse(row.at);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThanOrEqual(windowMs + 1000);
    }

    // aggregate points/solved MUST equal what the per-login solve rows imply
    const pointsCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:classic:points");
    const solvedCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:classic:solved");
    expect(pointsCmds.length).toBe(logins.size);
    expect(solvedCmds.length).toBe(logins.size);
    for (const login of logins) {
      const rowsForLogin = DEMO_CLASSIC_SOLVES.filter((s) => s.login === login);
      const expectedPoints = rowsForLogin.reduce(
        (sum, s) => sum + DEMO_CHALLENGES.find((c) => c.id === s.challengeId)!.points,
        0,
      );
      const pointsCmd = pointsCmds.find((c) => c[2] === login)!;
      const solvedCmd = solvedCmds.find((c) => c[2] === login)!;
      expect(Number(pointsCmd[3])).toBe(expectedPoints);
      expect(Number(solvedCmd[3])).toBe(rowsForLogin.length);
    }

    // solvecount per challenge MUST equal the number of DISTINCT logins that
    // solved it (the fixture has no duplicate (login, challengeId) pairs, so
    // this is just a row count per challenge)
    // Sent as ONE raise-only EVAL rather than per-challenge HSETs: the count is
    // keyed by challenge and counts distinct solvers across EVERYONE, so the
    // fixture's number is a floor. An absolute write rewrote a real
    // contestant's solve out of the public count on every re-seed (issue #335).
    const raise = cmds.find((c) => c[0] === "EVAL" && c[3] === "ctf:classic:solvecount")!;
    expect(raise).toBeDefined();
    expect(String(raise[1])).toContain("if current < floor then");
    const floors = new Map<string, number>();
    for (let i = 4; i < raise.length; i += 2) floors.set(String(raise[i]), Number(raise[i + 1]));

    const solvedChallengeIds = new Set(DEMO_CLASSIC_SOLVES.map((s) => s.challengeId));
    expect(floors.size).toBe(solvedChallengeIds.size);
    for (const challengeId of solvedChallengeIds) {
      const expectedCount = DEMO_CLASSIC_SOLVES.filter((s) => s.challengeId === challengeId).length;
      expect(floors.get(challengeId)).toBe(expectedCount);
    }
    // and never as a plain HSET, which is what discarded the real solves
    expect(cmds.some((c) => c[0] === "HSET" && c[1] === "ctf:classic:solvecount")).toBe(false);
  });

  it("writes no ctf:classic:* keys when the classic module is disabled", async () => {
    mockEnabledModules(["quiz"]);
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:classic:"))).toBe(false);
  });

  it("seeds ai challenges + flag/flagnorm (flag mode only) + signing keys, with NO flag in the public record", async () => {
    mockEnabledModules(["ai"]);
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    expect(DEMO_AI_CHALLENGES.some((c) => c.mode === "flag")).toBe(true);

    // Issue #355: NO demo challenge may be `event`-mode. Such a challenge can
    // only be solved by an external arena POSTing a signed event, and the
    // fixture's launch URLs are a documentation domain that does not resolve —
    // so seeding one put a 400-point row on the board with no flag form and a
    // dead Launch button, unclearable by anyone. This is the invariant, not a
    // description of today's data: reintroducing an event-mode fixture entry
    // has to fail here first.
    expect(DEMO_AI_CHALLENGES.filter((c) => c.mode === "event")).toEqual([]);
    for (const dc of DEMO_AI_CHALLENGES) {
      expect(dc.flag, `${dc.id} must be flag-gradable so the demo board is clearable`).not.toBe("");
    }

    // one HSET per challenge into the public challenges hash, with NO flag or
    // signing key field anywhere in the stored value
    const challengeRecords = seededRecords(cmds, "ctf:ai:challenges");
    expect(challengeRecords.length).toBe(DEMO_AI_CHALLENGES.length);
    for (const stored of challengeRecords) {
      expect(stored.flag).toBeUndefined();
      expect(stored.signingKey).toBeUndefined();
      expect(JSON.stringify(stored)).not.toMatch(/ctfbox/i);
      expect(JSON.stringify(stored)).not.toMatch(/aik_/);
    }

    // the authored flag hash holds the flag verbatim, and ONLY for the
    // graded (mode !== "event") challenges — an event-mode challenge has no
    // flag entries at all, since signed events assert that solve instead
    // Every fixture challenge is graded now (#355), so this set is all of
    // them; the `mode === "event"` arms below are kept because the SEED still
    // has that branch — the fixture no longer exercises it, and a future entry
    // could. `ai-store.authoring.test.ts` covers the same rule on the
    // authoring path, where an event-mode challenge can still be created.
    const gradedIds = new Set(DEMO_AI_CHALLENGES.filter((c) => c.mode !== "event").map((c) => c.id));
    expect(gradedIds.size).toBe(DEMO_AI_CHALLENGES.length);

    const flagCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:ai:flag");
    expect(flagCmds.length).toBe(gradedIds.size);
    for (const dc of DEMO_AI_CHALLENGES) {
      if (dc.mode === "event") {
        expect(flagCmds.some((c) => c[2] === dc.id)).toBe(false);
        continue;
      }
      const cmd = flagCmds.find((c) => c[2] === dc.id)!;
      expect(cmd[3]).toBe(dc.flag);
    }

    // the normalized flag hash is EXACTLY flagComparisonForm(authored) —
    // proven against classic-keys.ts's own function (ai-keys.ts re-exports the
    // identical one), never a re-derived formula — and also graded-only
    const flagnormCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:ai:flagnorm");
    expect(flagnormCmds.length).toBe(gradedIds.size);
    for (const dc of DEMO_AI_CHALLENGES) {
      if (dc.mode === "event") continue;
      const cmd = flagnormCmds.find((c) => c[2] === dc.id)!;
      expect(cmd[3]).toBe(flagComparisonForm(dc.flag, dc.caseSensitive));
    }

    // every challenge, graded or event-only, gets a signing key row — the
    // event-signature path needs one regardless of whether a flag is graded
    const signkeyCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:ai:signkey");
    expect(signkeyCmds.length).toBe(DEMO_AI_CHALLENGES.length);
    for (const dc of DEMO_AI_CHALLENGES) {
      const cmd = signkeyCmds.find((c) => c[2] === dc.id)!;
      expect(cmd[3]).toBe(dc.signingKey);
    }

    // handed to the script in display order; no bare SET of the key (#344)
    expect(scriptArgs(cmds, "ctf:ai:challenges").fixtureCategories).toEqual(DEMO_AI_CATEGORIES);
    expect(cmds.find((c) => c[0] === "SET" && c[1] === "ctf:ai:categories")).toBeUndefined();

    // the launch keypair is never touched by the seed — it is minted lazily on
    // first real use, not fixture data (see ai-store.ts's getAiLaunchKeys)
    expect(cmds.some((c) => c[1] === "ctf:ai:launchkey")).toBe(false);
  });

  it("seeds ai solves so aggregates agree with the per-login rows and solvecount", async () => {
    mockEnabledModules(["ai"]);
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    expect(DEMO_AI_SOLVES.length).toBeGreaterThan(0);

    // one HSET per solve into that login's own solves hash
    const solveCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith("ctf:ai:solves:"));
    expect(solveCmds.length).toBe(DEMO_AI_SOLVES.length);
    const logins = new Set(solveCmds.map((c) => String(c[1]).replace("ctf:ai:solves:", "")));
    expect(logins.size).toBeGreaterThan(1);

    // each stored solve row is well-formed and timestamped inside the same
    // ~6h window as the other seeded activity
    const windowMs = 6 * 60 * 60 * 1000;
    for (const c of solveCmds) {
      const row = JSON.parse(String(c[3]));
      expect(typeof row.points).toBe("number");
      const ageMs = Date.now() - Date.parse(row.at);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThanOrEqual(windowMs + 1000);
    }

    // aggregate points/solved MUST equal what the per-login solve rows imply
    // — the named failure mode this repo has hit before (seed/live-data
    // aggregate collision): the aggregates have to agree with the rows.
    const pointsCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:ai:points");
    const solvedCmds = cmds.filter((c) => c[0] === "HSET" && c[1] === "ctf:ai:solved");
    expect(pointsCmds.length).toBe(logins.size);
    expect(solvedCmds.length).toBe(logins.size);
    for (const login of logins) {
      const rowsForLogin = DEMO_AI_SOLVES.filter((s) => s.login === login);
      const expectedPoints = rowsForLogin.reduce(
        (sum, s) => sum + DEMO_AI_CHALLENGES.find((c) => c.id === s.challengeId)!.points,
        0,
      );
      const pointsCmd = pointsCmds.find((c) => c[2] === login)!;
      const solvedCmd = solvedCmds.find((c) => c[2] === login)!;
      expect(Number(pointsCmd[3])).toBe(expectedPoints);
      expect(Number(solvedCmd[3])).toBe(rowsForLogin.length);
    }

    // solvecount per challenge MUST equal the number of DISTINCT logins that
    // solved it (the fixture has no duplicate (login, challengeId) pairs)
    // Sent as ONE raise-only EVAL rather than per-challenge HSETs: the count is
    // keyed by challenge and counts distinct solvers across EVERYONE, so the
    // fixture's number is a floor. An absolute write rewrote a real
    // contestant's solve out of the public count on every re-seed (issue #335).
    const raise = cmds.find((c) => c[0] === "EVAL" && c[3] === "ctf:ai:solvecount")!;
    expect(raise).toBeDefined();
    expect(String(raise[1])).toContain("if current < floor then");
    const floors = new Map<string, number>();
    for (let i = 4; i < raise.length; i += 2) floors.set(String(raise[i]), Number(raise[i + 1]));

    const solvedChallengeIds = new Set(DEMO_AI_SOLVES.map((s) => s.challengeId));
    expect(floors.size).toBe(solvedChallengeIds.size);
    for (const challengeId of solvedChallengeIds) {
      const expectedCount = DEMO_AI_SOLVES.filter((s) => s.challengeId === challengeId).length;
      expect(floors.get(challengeId)).toBe(expectedCount);
    }
    // and never as a plain HSET, which is what discarded the real solves
    expect(cmds.some((c) => c[0] === "HSET" && c[1] === "ctf:ai:solvecount")).toBe(false);
  });

  it("writes no ctf:ai:* keys when the ai module is disabled", async () => {
    // default beforeEach mock: quiz + classic on, ai off
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:ai:"))).toBe(false);
  });

  // --- attempt rows -----------------------------------------------------
  //
  // The seed banks earned rows directly, so it used to produce an event in
  // which nobody had ever TRIED anything. Insights then reported a 100% solve
  // rate, "1.0" average tries and a blank median time on every challenge —
  // numbers that are each individually well-formed and collectively a lie.
  // These pin the attempt rows that make those figures mean something.

  for (const [module, prefix, earnedPrefix] of [
    ["quiz", "ctf:quiz:attempts:", "ctf:quiz:answers:"],
    ["classic", "ctf:classic:attempts:", "ctf:classic:solves:"],
  ] as const) {
    it(`records how many tries each seeded ${module} item took`, async () => {
      await seedDemoData("alice");
      const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

      const attemptCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith(prefix));
      const earnedCmds = cmds.filter((c) => c[0] === "HSET" && String(c[1]).startsWith(earnedPrefix));
      expect(earnedCmds.length).toBeGreaterThan(0);

      // EVERY earned row has an attempt row for the same (login, id). Without
      // this the average-tries column silently falls back to 1.0.
      const attemptKeys = new Set(attemptCmds.map((c) => `${c[1]}|${c[2]}`));
      for (const c of earnedCmds) {
        const login = String(c[1]).replace(earnedPrefix, "");
        expect(attemptKeys.has(`${prefix}${login}|${c[2]}`)).toBe(true);
      }

      const windowMs = 6 * 60 * 60 * 1000;
      for (const c of attemptCmds) {
        const row = JSON.parse(String(c[3]));
        // The live shape, field for field — a row metrics-store cannot parse
        // is the same as no row at all, but fails silently instead of loudly.
        expect(typeof row.attempts).toBe("number");
        expect(row.attempts).toBeGreaterThanOrEqual(1);
        expect(row.lastAtMs).toBe(Date.parse(row.lastAt));
        // firstAt at or before lastAt, and inside the seeded window. The
        // metrics fold DROPS a duration whose start is after its end, so a
        // reversed pair here would show up as a blank median, not an error.
        const firstMs = Date.parse(row.firstAt);
        expect(firstMs).toBeLessThanOrEqual(row.lastAtMs);
        expect(Date.now() - firstMs).toBeLessThanOrEqual(windowMs + 60 * 60 * 1000);
      }
    });
  }

  it("leaves some items attempted but never earned, so solve rates are not all 100%", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    // At least one (login, id) pair that has an attempt row and NO earned row.
    // This is the pair that makes a solve rate fall below 100%: the metrics
    // denominator counts everyone who tried, so with no failures recorded
    // every rate pins to exactly 100% no matter how hard the challenge was.
    const unearned = (attemptPrefix: string, earnedPrefix: string) => {
      const earned = new Set(
        cmds
          .filter((c) => c[0] === "HSET" && String(c[1]).startsWith(earnedPrefix))
          .map((c) => `${String(c[1]).replace(earnedPrefix, "")}|${c[2]}`),
      );
      return cmds
        .filter((c) => c[0] === "HSET" && String(c[1]).startsWith(attemptPrefix))
        .filter((c) => !earned.has(`${String(c[1]).replace(attemptPrefix, "")}|${c[2]}`));
    };

    expect(unearned("ctf:quiz:attempts:", "ctf:quiz:answers:").length).toBeGreaterThan(0);
    expect(unearned("ctf:classic:attempts:", "ctf:classic:solves:").length).toBeGreaterThan(0);
  });

  it("gives every attempt row a nonzero duration, one-try rows included", async () => {
    // Deriving firstAt from the gaps BETWEEN tries alone leaves a one-try row
    // with firstAt === lastAt, and Insights then reported a median
    // time-to-solve of "0s" — arithmetically honest and factually impossible.
    // A first try is not the moment the contestant met the challenge; the
    // reading came first.
    await seedDemoData("alice");
    const rows = mocks.upstashPipeline.mock.calls.at(-1)![0]
      .filter((c) => c[0] === "HSET" && /^ctf:(quiz|classic):attempts:/.test(String(c[1])))
      .map((c) => JSON.parse(String(c[3])) as { attempts: number; firstAt: string; lastAtMs: number });

    expect(rows.length).toBeGreaterThan(0);
    // The one-try rows are the ones that regress, so fail loudly if the
    // fixture ever stops producing any and this test goes quietly vacuous.
    expect(rows.some((r) => r.attempts === 1)).toBe(true);
    for (const r of rows) {
      expect(r.lastAtMs - Date.parse(r.firstAt)).toBeGreaterThan(0);
    }
  });

  it("takes more than one try on some items, so average tries is not a flat 1.0", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    const tries = cmds
      .filter((c) => c[0] === "HSET" && /^ctf:(quiz|classic):attempts:/.test(String(c[1])))
      .map((c) => JSON.parse(String(c[3])).attempts as number);
    expect(tries.some((t) => t > 1)).toBe(true);
  });

  it("keeps the same attempt rows on a re-seed (absolute HSET, never an increment)", async () => {
    // The seed is documented as idempotent and the aggregates are written as
    // absolute totals for that reason. An attempt row written with HINCRBY, or
    // with a time derived from Date.now() per-run, would break that quietly:
    // the second seed would double the tries instead of replacing them.
    await seedDemoData("alice");
    const first = mocks.upstashPipeline.mock.calls.at(-1)![0].filter(
      (c) => /^ctf:(quiz|classic):attempts:/.test(String(c[1])),
    );
    // Non-empty FIRST. Both assertions below are `.every()`, which is
    // vacuously true over an empty array — without this line the test passed
    // against a seed that wrote no attempt rows at all, which is precisely the
    // bug it exists to catch.
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((c) => c[0] === "HSET")).toBe(true);
    expect(first.every((c) => JSON.parse(String(c[3])).attempts >= 1)).toBe(true);
  });
});

// The seed used to `SET` both category lists to the fixture's, deleting every
// category an organizer had authored. Their challenges survived — written
// per-field and keyed by id — and the admin panel kept listing them, but the
// contestant board renders only categories present in the list, so authored
// content silently left the board while "1 category · 5 challenges" read like
// a healthy setup (issue #344).
//
// The union itself is Lua now, and Lua is only really pinned by RUNNING it:
// `admin-store.upstash.test.ts` executes SEED_CATEGORIES_SCRIPT against a real
// Redis for the order, the case-insensitive dedupe, the canonical rewrite of
// the challenge rows and the cap refusal. What is left to assert HERE is the
// contract this file controls — that the seed hands the script the right
// arguments, and that nothing writes those keys behind its back.
describe("seedDemoData hands its category work to one atomic script", () => {
  beforeEach(() => {
    mockEnabledModules(["classic", "ai"]);
  });

  it("writes both category keys ONLY through the script, never a bare SET", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];
    // The regression guard for #344: an absolute SET of either key is the bug.
    for (const key of ["ctf:classic:categories", "ctf:ai:categories"]) {
      expect(cmds.find((c) => c[0] === "SET" && c[1] === key), key).toBeUndefined();
      expect(cmds.find((c) => c[0] === "EVAL" && c[3] === key), key).toBeTruthy();
    }
  });

  it("reads nothing first — the union happens inside the write", async () => {
    // A GET here and a SET later is the race the script exists to close: on a
    // non-transactional pipeline an organizer's edit can land between them.
    await seedDemoData("alice");
    const reads = mocks.upstashPipeline.mock.calls.map((c) => c[0]).filter((cs) => cs.some((c) => c[0] === "GET"));
    expect(reads).toEqual([]);
  });

  it("passes each module its own keys, fixture categories and cap", async () => {
    await seedDemoData("alice");
    const cmds = mocks.upstashPipeline.mock.calls.at(-1)![0];

    const classic = scriptArgs(cmds, "ctf:classic:challenges");
    expect(classic.categoriesKey).toBe("ctf:classic:categories");
    expect(classic.fixtureCategories).toEqual(DEMO_CLASSIC_CATEGORIES);
    expect(classic.max).toBe(CLASSIC_CATEGORIES_MAX);
    expect(classic.records.map((r) => r.id).sort()).toEqual(DEMO_CHALLENGES.map((c) => c.id).sort());

    const ai = scriptArgs(cmds, "ctf:ai:challenges");
    expect(ai.categoriesKey).toBe("ctf:ai:categories");
    expect(ai.fixtureCategories).toEqual(DEMO_AI_CATEGORIES);
    expect(ai.max).toBe(AI_CATEGORIES_MAX);
    expect(ai.records.map((r) => r.id).sort()).toEqual(DEMO_AI_CHALLENGES.map((c) => c.id).sort());

    // Both scripts are the same source — one implementation, two modules.
    expect(cmds.filter((c) => c[0] === "EVAL" && c[1] === SEED_CATEGORIES_SCRIPT)).toHaveLength(2);
  });

  it("throws instead of reporting a seed that partly failed", async () => {
    // `upstashPipeline` reports a per-command failure in the RESULT and does
    // not throw (AGENTS.md), so the script refusing an over-cap union would
    // otherwise return a cheerful count for a seed that did not happen.
    mocks.upstashPipeline.mockImplementation(async (cmds) =>
      cmds.map((c) => (c[0] === "EVAL" ? { error: "seed would take the category list to 52, over the limit of 50" } : { result: [] })),
    );
    await expect(seedDemoData("alice")).rejects.toThrow(/over the limit of 50/);
  });

  it("logs but does not throw when only the trailing audit LPUSH/LTRIM fail — the seed itself already succeeded", async () => {
    // The describe's own beforeEach already queued the settings-read
    // response (call 1: "classic,ai"); this Once value lines up with the
    // SECOND pipeline call, the write batch.
    mocks.upstashPipeline.mockImplementationOnce(async (cmds) =>
      cmds.map((c, i) => (i >= cmds.length - 2 ? { error: "NOAUTH Authentication required." } : { result: "OK" })),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await seedDemoData("alice");
    expect(result.contestants).toBe(DEMO_CONTESTANTS.length);
    expect(spy).toHaveBeenCalledWith("[admin] seed audit write failed:", expect.stringContaining("NOAUTH"));
    spy.mockRestore();
  });
});
