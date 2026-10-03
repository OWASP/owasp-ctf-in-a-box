// Grading for both ai solve paths. Needs a PARTIAL @/lib/admin-store mock
// (real `effectivePaused`, mocked `getAdminSettings`), which is why it is not
// in ai-store.test.ts.
//
// ANTI-VACUOUS: every refusal below is paired with the accepting case built
// from the same fixture — a refusal test whose fixture never worked proves
// nothing about the refusal.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn(),
  upstashPipeline: vi.fn(),
  getAdminSettings: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));
vi.mock("@/lib/admin-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-store")>()),
  getAdminSettings: mocks.getAdminSettings,
}));

import { AI_COOLDOWN_SEC, awardAiEvent, submitAiFlag } from "@/lib/ai-store";

/** The settings object `effectivePaused` (real, not mocked) reads, plus
 *  `aiCooldownSec` which `resolveSettings` reads directly. Every field it
 *  looks at must be present, or a missing key reads as a different event
 *  state than the test intends. */
type SettingsOverride = Partial<{
  paused: boolean;
  scoringStartsAt: string | null;
  scoringEndsAt: string | null;
  aiCooldownSec: number | null;
}>;
// The base fixture is a LAUNCHED event: since #464 a missing scoring start
// means "not launched" and every grader refuses as paused, so the happy-path
// tests below need an explicit start in the past.
const LAUNCHED_AT = "2000-01-01T00:00:00.000Z";
const settings = (over: SettingsOverride = {}) =>
  ({ paused: false, scoringStartsAt: LAUNCHED_AT, scoringEndsAt: null, aiCooldownSec: null, ...over }) as never;

/** No prior solve, no prior attempt — the gate's own pre-check reads. */
function cleanGateReply() {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }, { result: null }]);
}

/** The script, KEYS and ARGV of the most recent `upstashEval`. */
function lastEval(): { script: string; keys: string[]; argv: (string | number)[] } {
  const calls = mocks.upstashEval.mock.calls;
  const [script, keys, argv] = calls[calls.length - 1] as [string, string[], (string | number)[]];
  return { script, keys, argv };
}

beforeEach(() => {
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockReset();
  mocks.getAdminSettings.mockReset();
  mocks.getAdminSettings.mockResolvedValue(settings());
});

describe("submitAiFlag", () => {
  it("awards a correct flag", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);

    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", " CTF{leak} ")).toEqual({
      ok: true,
      correct: true,
      points: 300,
    });
  });

  it("hands BOTH comparison forms to the script and normalizes in JS, never Lua", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["incorrect", "1"]);

    await submitAiFlag("alice", "prompt-leak-ab12cd", " CTF{Leak} ");

    const [, , argv] = mocks.upstashEval.mock.calls[0] as [string, string[], (string | number)[]];
    expect(argv[1]).toBe("ctf{leak}");   // case-insensitive form
    expect(argv[6]).toBe("CTF{Leak}");   // case-preserved form
    expect(argv[7]).toBe("1");           // grade = yes
    expect(argv[8]).toBe("flag");        // solve source
  });

  it("reports a wrong flag without awarding", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["incorrect", "2"]);
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "nope")).toEqual({ ok: true, correct: false });
  });

  it("returns already for an idempotent resubmission", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["already"]);
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: true,
      correct: true,
      points: 0,
      already: true,
    });
  });

  it("refuses while the event is paused, without touching Redis", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("refuses before launch — no scoring start at all (#464)", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null }));
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  // #567: a passed scheduled END is its own reason, distinct from a pause.
  it("refuses with `ended` once the scheduled scoring end has passed", async () => {
    mocks.getAdminSettings.mockResolvedValue(
      settings({
        scoringStartsAt: new Date(Date.now() - 7_200_000).toISOString(),
        scoringEndsAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: false,
      reason: "ended",
    });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("treats scoring as LIVE when the settings read fails — fail open", async () => {
    mocks.getAdminSettings.mockRejectedValue(new Error("redis down"));
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: true,
      correct: true,
      points: 300,
    });
    // ...and the script still gets a real cooldown to enforce — the module
    // default, since there is no settings object to read an override from.
    expect(lastEval().argv[4]).toBe(AI_COOLDOWN_SEC * 1000);
  });

  it("fails CLOSED with its own reason when the solve/attempt lookup fails", async () => {
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("redis down"));
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("surfaces the script's cooldown verdict with a retryAt", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["cooldown", "1756636805000"]);
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}")).toEqual({
      ok: false,
      reason: "cooldown",
      retryAt: new Date(1_756_636_805_000).toISOString(),
    });
  });

  it("rejects a malformed id or empty flag before any Redis call", async () => {
    expect(await submitAiFlag("alice", "bad id!", "CTF{leak}")).toEqual({ ok: false, reason: "invalid" });
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "   ")).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("awardAiEvent", () => {
  it("awards without a flag and marks the solve as event-sourced", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "400"]);

    expect(await awardAiEvent("alice", "guardrail-cd34ef")).toEqual({ ok: true, correct: true, points: 400 });

    const [, , argv] = mocks.upstashEval.mock.calls[0] as [string, string[], (string | number)[]];
    expect(argv[7]).toBe("0");      // grade = no
    expect(argv[8]).toBe("event");  // solve source
  });

  it("is idempotent for a repeated event", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["already"]);
    expect(await awardAiEvent("alice", "guardrail-cd34ef")).toEqual({
      ok: true,
      correct: true,
      points: 0,
      already: true,
    });
  });

  // #464: a dry run goes through AWARD_SCRIPT itself (its trailing dry
  // argument), not a TS short-circuit — so the script's own missing/mode/
  // already checks apply and it reports the challenge's real points.
  it("dryRun runs every gate and the SAME script, told to write nothing", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "400", "dry"]);
    expect(await awardAiEvent("alice", "guardrail-cd34ef", { dryRun: true })).toEqual({
      ok: true,
      correct: true,
      points: 400,
      dryRun: true,
    });
    const { argv } = lastEval();
    expect(argv[7]).toBe("0"); // the event path — no flag comparison
    expect(argv[9]).toBe("1"); // dry
  });

  it("dryRun still reports a refusal — paused", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    expect(await awardAiEvent("alice", "guardrail-cd34ef", { dryRun: true })).toEqual({
      ok: false,
      reason: "paused",
    });
  });

  it("dryRun reports an already-solved challenge without writing", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: JSON.stringify({ points: 400, at: "2026-08-31T11:00:00.000Z" }) },
      { result: null },
    ]);
    expect(await awardAiEvent("alice", "guardrail-cd34ef", { dryRun: true })).toEqual({
      ok: false,
      reason: "solved",
    });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  // The two directions of the mode gate. The graded path is refused for an
  // event-only challenge by accident (no `flagnorm` row -> 'missing'); the
  // mirror is not accidental, it is the guard below.
  it("refuses an event asserted against a mode:\"flag\" challenge, as its own reason", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["mode"]);
    expect(await awardAiEvent("alice", "guardrail-cd34ef")).toEqual({ ok: false, reason: "wrong-mode" });
  });

  it("does not report a mode refusal as 'invalid' — the two are different bugs", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["missing"]);
    expect(await awardAiEvent("alice", "guardrail-cd34ef")).toEqual({ ok: false, reason: "invalid" });
  });
});

// Mirrors classic-store.grade.test.ts's "the grading script itself" block.
// upstashEval is mocked, so nothing here executes Lua — these pin the SHAPE of
// the script the store hands to Redis, which is the only thing that makes the
// module's docstrings about ordering and secrecy true rather than aspirational.
// Without them the script could be rewritten to spend an attempt on the event
// path, to increment the counters before the already-solved guard, to
// lowercase in Lua, or to be handed `ctf:ai:flag` instead of `ctf:ai:flagnorm`,
// and every other test in this file would still pass.
describe("the award script itself (text invariants)", () => {
  it("guards the already-solved check before ANY write and gates the counters behind the correctness check", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "x");
    const { script } = lastEval();

    const missing = script.indexOf("'missing'");
    const guard = script.indexOf("HEXISTS");
    const modeGuard = script.indexOf("'mode'");
    const cooldownReturn = script.indexOf("'cooldown'");
    const attemptsWrite = script.indexOf("HSET', KEYS[1]");
    const incorrectReturn = script.indexOf("'incorrect'");
    const solveWrite = script.indexOf("HSET', KEYS[2]");
    const pointsIncr = script.indexOf("HINCRBY', KEYS[5]");
    const solvedIncr = script.indexOf("HINCRBY', KEYS[7]");
    const solveCountIncr = script.indexOf("HINCRBY', KEYS[6]");
    for (const idx of [
      missing,
      guard,
      modeGuard,
      cooldownReturn,
      attemptsWrite,
      incorrectReturn,
      solveWrite,
      pointsIncr,
      solvedIncr,
      solveCountIncr,
    ]) {
      expect(idx).toBeGreaterThan(-1);
    }

    expect(missing).toBeLessThan(guard);
    // Every refusal is decided before anything is written. The mode gate in
    // particular must not cost the caller an attempt, and the cooldown
    // re-check must precede the attempt spend — a refusal writes nothing.
    expect(guard).toBeLessThan(modeGuard);
    expect(modeGuard).toBeLessThan(cooldownReturn);
    expect(cooldownReturn).toBeLessThan(attemptsWrite);
    expect(attemptsWrite).toBeLessThan(incorrectReturn);
    expect(incorrectReturn).toBeLessThan(solveWrite);
    // Because the already-solved guard precedes every increment, a login can
    // never bump the per-challenge solve counter twice — which is what makes
    // getAiSolveCounts distinct-by-construction.
    expect(guard).toBeLessThan(pointsIncr);
    expect(guard).toBeLessThan(solvedIncr);
    expect(guard).toBeLessThan(solveCountIncr);
    expect(solveWrite).toBeLessThan(pointsIncr);
    expect(pointsIncr).toBeLessThan(solvedIncr);
    expect(solvedIncr).toBeLessThan(solveCountIncr);
  });

  it("confines the flag comparison to the graded branch — the event path compares nothing", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "x");
    const { script } = lastEval();

    // The graded branch runs from `if ARGV[8] == '1' then` to the `end` at
    // column 0; every nested `end` inside it is indented, so "\nend\n" finds
    // the closing one and nothing else.
    const start = script.indexOf("if ARGV[8] == '1' then");
    expect(start).toBeGreaterThan(-1);
    const close = script.indexOf("\nend\n", start);
    expect(close).toBeGreaterThan(start);
    const graded = script.slice(start, close);
    const afterGraded = script.slice(close);

    // The flag lives ONLY inside the graded branch.
    expect(graded).toContain("local target = redis.call('HGET', KEYS[3], ARGV[1])");
    expect(graded).toContain("if target ~= submitted then");
    expect(afterGraded).not.toContain("KEYS[3]");
    expect(afterGraded).not.toContain("~=");
    // ...and the attempt spend does too: a signed event has no wrong answer,
    // so it must never consume one.
    expect(afterGraded).not.toContain("KEYS[1]");
    // The whole flag value is compared, never pattern-matched out of a blob —
    // a flag routinely contains braces, quotes and backslashes.
    expect(script).not.toContain("string.match(target");
  });

  it("refuses a mode:\"flag\" challenge on the event path, off the record it already holds", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "400"]);
    await awardAiEvent("alice", "guardrail-cd34ef");
    const { script } = lastEval();

    // ARGV[8] == '0' is the event path. Anchored with a trailing [,}] like the
    // points match, and read off `cRaw` — no caller string is interpolated.
    expect(script).toContain(`if ARGV[8] == '0' and string.match(cRaw, '"mode":"flag"[,}]') then return {'mode'} end`);
    // It must be specific to "flag": "event" and "both" go through.
    expect(script).not.toContain(`'"mode":"event"`);
    expect(script).not.toContain(`'"mode":"both"`);
  });

  it("never normalizes in Lua — string.lower is ASCII-only and would disagree with normalizeFlag", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "x");
    expect(lastEval().script).not.toContain("string.lower");
    expect(lastEval().script).not.toContain("string.upper");
  });

  it("is handed ctf:ai:flagnorm and NEVER ctf:ai:flag or ctf:ai:signkey", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "x");
    const { keys } = lastEval();

    // Element-wise, not substring: "ctf:ai:flag" IS a prefix of
    // "ctf:ai:flagnorm", so a JSON.stringify().not.toContain() check here
    // would be unsatisfiable and prove nothing.
    expect(keys).toContain("ctf:ai:flagnorm");
    expect(keys).not.toContain("ctf:ai:flag");
    expect(keys).not.toContain("ctf:ai:signkey");
    expect(keys).not.toContain("ctf:ai:hints");
  });

  it("hands the event path the same KEYS — no flag hash appears there either", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "400"]);
    await awardAiEvent("alice", "guardrail-cd34ef");
    const { keys, argv } = lastEval();
    expect(keys).not.toContain("ctf:ai:flag");
    expect(keys).not.toContain("ctf:ai:signkey");
    // Both comparison forms are empty on this path — there is nothing to grade.
    expect(argv[1]).toBe("");
    expect(argv[6]).toBe("");
  });
});

// Mirrors classic-store.grade.test.ts's cooldown-resolution coverage exactly,
// field-swapped: `aiCooldownSec` beside `classicCooldownSec`, same [0, 3600]
// bound, same "current setting, never a stored cutoff" contract.
describe("aiCooldownSec resolution", () => {
  it("passes the CURRENT aiCooldownSec setting to the script, never a stored cutoff", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ aiCooldownSec: 12 }));
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}");
    expect(lastEval().argv[4]).toBe(12_000);
  });

  it("falls back to the module default cooldown when no admin override is set", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}");
    expect(lastEval().argv[4]).toBe(AI_COOLDOWN_SEC * 1000);
  });

  it("passes 0 through as 'no cooldown' rather than falling back to the default", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ aiCooldownSec: 0 }));
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "300"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}");
    expect(lastEval().argv[4]).toBe(0);
  });
});

describe("grading failures never reach the log with the request attached", () => {
  it("logs a fixed diagnostic and the error's name/message — not the error object, whose own fields can carry the flag", async () => {
    const FLAG = "CTF{do-not-log-me}";
    // A driver that decorates its rejection with the request it failed on is
    // the whole danger: `upstashEval`'s ARGV carries BOTH the submitted flag
    // and its comparison form, so one `console.error(err)` writes the event's
    // flags to the log. The error's own `message` says nothing about them.
    const decorated = Object.assign(new Error("Upstash EVAL failed: ERR timeout"), {
      command: ["EVAL", "...", FLAG, FLAG.toLowerCase()],
      cause: new Error(`while sending ${FLAG}`),
    });
    cleanGateReply();
    mocks.upstashEval.mockRejectedValueOnce(decorated);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await submitAiFlag("alice", "prompt-leak-ab12cd", FLAG)).toEqual({ ok: false, reason: "error" });

      // Anti-vacuous: the failure really did reach the logger, and said so.
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls[0] as unknown[];
      expect(String(logged[0])).toContain("ai grading failed");
      expect(logged.some((arg) => arg instanceof Error)).toBe(false);
      const rendered = logged.map((arg) => JSON.stringify(arg)).join(" ");
      expect(rendered).not.toContain(FLAG);
      expect(rendered).not.toContain(FLAG.toLowerCase());
      // What IS kept: enough to tell one failure from another.
      expect(rendered).toContain("ERR timeout");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("dry run (#464 admin preview)", () => {
  it("submitAiFlag grades before launch through the script with ARGV[10] = \"1\"", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null }));
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "40", "dry"]);
    expect(await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}", { dryRun: true })).toEqual({
      ok: true,
      correct: true,
      points: 40,
      dryRun: true,
    });
    const [, , argv] = mocks.upstashEval.mock.calls.at(-1)!;
    expect(argv[9]).toBe("1");
  });

  it("a normal flag passes ARGV[10] = \"0\"", async () => {
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "40"]);
    await submitAiFlag("alice", "prompt-leak-ab12cd", "CTF{leak}");
    const [, , argv] = mocks.upstashEval.mock.calls.at(-1)!;
    expect(argv[9]).toBe("0");
  });

  it("awardAiEvent for a PREVIEW grades before launch as a dry run (the Send test's paused verdict otherwise stands)", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null }));
    expect(await awardAiEvent("alice", "prompt-leak-ab12cd", { dryRun: true })).toEqual({ ok: false, reason: "paused" });
    cleanGateReply();
    mocks.upstashEval.mockResolvedValueOnce(["correct", "40", "dry"]);
    expect(await awardAiEvent("alice", "prompt-leak-ab12cd", { preview: true })).toEqual({
      ok: true,
      correct: true,
      points: 40,
      dryRun: true,
    });
    expect(lastEval().argv[9]).toBe("1");
  });
});
