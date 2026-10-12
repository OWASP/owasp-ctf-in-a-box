// Unit tests for the classic submission gate and flag grading. Upstash is
// mocked, so "correct"/"incorrect"/"already"/"cooldown" verdicts from the Lua
// script are simulated via mocked upstashEval replies — the actual comparison
// and the atomic guards live in SUBMIT_SCRIPT (a Lua string this file can
// inspect but not execute), so those invariants are proven here by asserting
// on the script's own TEXT and on the args sent into it, the same way
// quiz-store.grade.test.ts proves GRADE_SCRIPT's ordering.

import { beforeEach, describe, expect, it, vi } from "vitest";
// #463/#602: the team's lock keys come from the team store; pinned here. The
// Lua fragment is the real one, so SUBMIT_SCRIPT is the shipped script.
const classicTeam = vi.hoisted(() => ({
  teamLockKeys: vi.fn(async (login: string) => ({
    team: "red",
    keys: [`ctf:classic:solves:${login}`, `ctf:user:${login}`, "ctf:classic:solves:bob", "ctf:user:bob"],
  })),
}));
vi.mock("@/lib/classic-team", async (orig) => ({
  storyLockLua: (await orig<typeof import("@/lib/classic-team")>()).storyLockLua,
  teamLockKeys: classicTeam.teamLockKeys,
}));

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  getAdminSettings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({
  upstashEval: mocks.upstashEval,
  upstashPipeline: mocks.upstashPipeline,
}));
vi.mock("@/lib/admin-store", async (orig) => ({
  // Real `effectivePaused` (pure logic over the settings object) — only
  // `getAdminSettings` (the Redis read) is mocked.
  ...(await orig<typeof import("@/lib/admin-store")>()),
  getAdminSettings: mocks.getAdminSettings,
}));

import { CLASSIC_COOLDOWN_SEC, submitFlag, upsertChallenge } from "@/lib/classic-store";

type SettingsOverride = Partial<{
  paused: boolean;
  scoringStartsAt: string | null;
  scoringEndsAt: string | null;
  classicCooldownSec: number | null;
}>;

// The base fixture is a LAUNCHED event: since #464 a missing scoring start
// means "not launched" and every grader refuses as paused, so the happy-path
// tests below need an explicit start in the past.
const LAUNCHED_AT = "2000-01-01T00:00:00.000Z";
const settings = (over: SettingsOverride = {}) => ({
  paused: false,
  scoringStartsAt: LAUNCHED_AT,
  scoringEndsAt: null,
  classicCooldownSec: null,
  ...over,
});

const solveRow = (points: number, at: string) => JSON.stringify({ points, at });
const attemptRow = (attempts: number, lastAt: string) => JSON.stringify({ attempts, lastAt });

/** Mocks the gate's one pipeline call: HGET on the solves hash, then HGET on
 *  the attempts hash, in that order. */
function gateReads(solve: string | null, attempt: string | null) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: solve }, { result: attempt }]);
}

/** The next `upstashEval` resolves to this script verdict. */
function evalReturns(verdict: unknown[]) {
  mocks.upstashEval.mockResolvedValueOnce(verdict);
}

const evalCalls = () => mocks.upstashEval.mock.calls;
/** The most recent grading call, destructured. */
const lastEval = () => {
  const [script, keys, argv] = mocks.upstashEval.mock.calls.at(-1) as [string, string[], (string | number)[]];
  return { script, keys, argv };
};

beforeEach(() => {
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockReset();
  mocks.getAdminSettings.mockReset();
  mocks.getAdminSettings.mockResolvedValue(settings());
  // Default gate reads: nothing solved, nothing attempted — the gate allows.
  mocks.upstashPipeline.mockResolvedValue([{ result: null }, { result: null }]);
  mocks.upstashEval.mockResolvedValue(["incorrect", "1"]);
});

describe("submitFlag normalization", () => {
  it("normalizes the submission with the same recipe as authoring", async () => {
    await submitFlag("alice", "chal-1", "  CTF{Flag}  ");
    expect(lastEval().argv[1]).toBe("ctf{flag}");
  });

  it("stores and submits a byte-identical value for the same flag, including non-ASCII — the whole whole-value-compare design depends on this", async () => {
    // Authoring: precomposed e-acute, padded. Written as an escape sequence
    // so the two spellings below stay distinguishable in the source.
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }, { result: 1 }]);
    await upsertChallenge(
      {
        id: "chal-1",
        title: "T",
        category: "Web",
        description: "",
        points: 50,
        order: 1,
      },
      "  CTF{caf\u00e9}  ", // e-acute as ONE code point
    );
    const upsertCmds = mocks.upstashPipeline.mock.calls.at(-1)![0] as (string | number)[][];
    const storedNorm = upsertCmds.find((c) => c[1] === "ctf:classic:flagnorm")![3];

    // Submission: the SAME flag typed with a combining accent (e + U+0301)
    // and different casing. NFC-then-lowercase makes the two agree; a Lua-side
    // `string.lower` never would.
    gateReads(null, null);
    evalReturns(["correct", "50"]);
    await submitFlag("alice", "chal-1", "CTF{CAFE\u0301}");

    expect(lastEval().argv[1]).toBe(storedNorm);
    expect(storedNorm).toBe("ctf{caf\u00e9}");
  });

  it("hands the script only forms of the SUBMISSION, never anything from storage", async () => {
    await submitFlag("alice", "chal-1", "CTF{Flag}");
    const { argv, keys } = lastEval();

    // Two flag arguments now, both derived from what the contestant typed:
    // the case-insensitive form (the default) and the case-preserving one the
    // script uses for a case-sensitive challenge (issue #193).
    expect(argv[1]).toBe("ctf{flag}");
    expect(argv[6]).toBe("CTF{Flag}");

    // This test used to assert `argv` did not contain "CTF{Flag}" verbatim.
    // That held only incidentally — the one form we sent happened to be
    // lowercased — and it was never the property worth protecting. ARGV
    // carries the CONTESTANT'S OWN INPUT, which they already know; the secret
    // is the AUTHORED flag, and the invariant is that it never reaches the
    // script at all. That is what the key assertions below check, and they are
    // unchanged.
    expect(keys).not.toContain("ctf:classic:flag");
    expect(keys[2]).toBe("ctf:classic:flagnorm");
  });
});

/** Upserts a challenge and returns the pipeline it wrote. Mirrors the
 *  hand-rolled setup in the non-ASCII test above; extracted here because the
 *  case-sensitivity cases all need the same two things — the stored comparison
 *  form and the stored public record. */
async function upsertAndCapture(
  extra: { caseSensitive?: boolean },
  flag: string,
): Promise<(string | number)[][]> {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }, { result: 1 }, { result: 1 }]);
  await upsertChallenge(
    { id: "chal-1", title: "T", category: "Web", description: "", points: 50, order: 1, ...extra },
    flag,
  );
  return mocks.upstashPipeline.mock.calls.at(-1)![0] as (string | number)[][];
}

describe("case-sensitive challenges (issue #193)", () => {
  it("stores a case-sensitive challenge's comparison form with case intact", async () => {
    const cmds = await upsertAndCapture({ caseSensitive: true }, "CTF{Flag}");
    const storedNorm = cmds.find((c) => c[1] === "ctf:classic:flagnorm")![3];
    expect(storedNorm).toBe("CTF{Flag}");
  });

  it("still trims and NFC-normalizes a case-sensitive flag", async () => {
    // Only the lowercasing is optional. A trailing space a contestant cannot
    // see is not a wrong answer, and two spellings that render identically
    // must still compare equal — neither is what "case-sensitive" asks for.
    const cmds = await upsertAndCapture({ caseSensitive: true }, "  CTF{CAFE\u0301}  ");
    const storedNorm = cmds.find((c) => c[1] === "ctf:classic:flagnorm")![3];
    expect(storedNorm).toBe("CTF{CAF\u00c9}");
  });

  it("leaves a normal challenge lowercased, exactly as before", async () => {
    const cmds = await upsertAndCapture({}, "CTF{Flag}");
    const storedNorm = cmds.find((c) => c[1] === "ctf:classic:flagnorm")![3];
    expect(storedNorm).toBe("ctf{flag}");
  });

  it("omits the field entirely when the challenge is not case-sensitive", async () => {
    // Present-only-when-true, so a board with no case-sensitive challenge
    // stores byte-identically to how it did before this feature existed.
    const cmds = await upsertAndCapture({}, "CTF{Flag}");
    const record = JSON.parse(String(cmds.find((c) => c[1] === "ctf:classic:challenges")![3]));
    expect("caseSensitive" in record).toBe(false);
  });

  it("the script picks the case-preserving form only when the record says so", async () => {
    await submitFlag("alice", "chal-1", "x");
    const { script } = lastEval();
    // Absence must mean insensitive: every challenge authored before this
    // existed has no field, and must keep the forgiving comparison.
    expect(script).toContain(`string.match(cRaw, '"caseSensitive":true[,}]')`);
    expect(script).toContain("if caseSensitive then submitted = ARGV[7] end");
  });

  it("still never does case handling in Lua", async () => {
    // The whole reason both forms are computed in JS and shipped in. A Lua
    // string.lower would be ASCII-only and disagree with normalizeFlag on any
    // non-ASCII flag, producing a challenge nobody can solve.
    await submitFlag("alice", "chal-1", "x");
    const { script } = lastEval();
    expect(script).not.toContain("string.lower");
    expect(script).not.toContain("string.upper");
  });
});

describe("the gate (checked before the grading script ever runs)", () => {
  it("refuses when scoring is paused, without touching the grading script", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    const res = await submitFlag("alice", "chal-1", "x");
    expect(res).toEqual({ ok: false, reason: "paused" });
    expect(evalCalls()).toHaveLength(0);
    // Not even the gate's own lookup ran.
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("refuses outside the scheduled scoring window — the real effectivePaused, not a mocked one", async () => {
    mocks.getAdminSettings.mockResolvedValue(
      settings({ scoringStartsAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "paused" });
    expect(evalCalls()).toHaveLength(0);
  });

  it("refuses before launch — no scoring start at all (#464)", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null }));
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "paused" });
    expect(evalCalls()).toHaveLength(0);
  });

  // #567: after the scheduled END the refusal is its own reason, so the
  // contestant reads "the event has ended" rather than "paused, try again
  // later". A freeze toggled on top of a passed end is still the end.
  it("refuses with `ended` once the scheduled scoring end has passed — distinct from a pause", async () => {
    mocks.getAdminSettings.mockResolvedValue(
      settings({
        scoringStartsAt: new Date(Date.now() - 7_200_000).toISOString(),
        scoringEndsAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "ended" });
    expect(evalCalls()).toHaveLength(0);
    mocks.getAdminSettings.mockResolvedValue(
      settings({
        paused: true,
        scoringStartsAt: new Date(Date.now() - 7_200_000).toISOString(),
        scoringEndsAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "ended" });
  });

  it("refuses a challenge this login already solved, without spending an attempt", async () => {
    gateReads(solveRow(50, "2026-08-19T10:00:00.000Z"), null);
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "solved" });
    expect(evalCalls()).toHaveLength(0);
  });

  it("refuses inside the cooldown and reports retryAt derived from the CURRENT setting", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ classicCooldownSec: 60 }));
    const lastAt = new Date(Date.now() - 10_000).toISOString();
    gateReads(null, attemptRow(1, lastAt));
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({
      ok: false,
      reason: "cooldown",
      retryAt: new Date(Date.parse(lastAt) + 60_000).toISOString(),
    });
    expect(evalCalls()).toHaveLength(0);
  });

  it("lifts the lock immediately when the organizer lowers the cooldown — retryAt is derived, never stored", async () => {
    const lastAt = new Date(Date.now() - 10_000).toISOString(); // unchanged
    mocks.getAdminSettings.mockResolvedValue(settings({ classicCooldownSec: 60 }));
    gateReads(null, attemptRow(1, lastAt));
    expect(await submitFlag("alice", "chal-1", "x")).toMatchObject({ ok: false, reason: "cooldown" });

    mocks.getAdminSettings.mockResolvedValue(settings({ classicCooldownSec: 5 }));
    gateReads(null, attemptRow(1, lastAt));
    evalReturns(["incorrect", "2"]);
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: true, correct: false });
  });

  it("fails CLOSED with 'unavailable' when the lookup itself errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    const res = await submitFlag("alice", "chal-1", "x");
    // Deliberately NOT reported as a spent attempt or a cooldown: telling a
    // contestant a false fact about their own attempts is worse than telling
    // them the check failed.
    expect(res).toEqual({ ok: false, reason: "unavailable" });
    expect(evalCalls()).toHaveLength(0);
    consoleError.mockRestore();
  });

  it("fails OPEN when the SETTINGS read errors — a Redis blip must never silently drop a live submission", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAdminSettings.mockRejectedValueOnce(new Error("upstash down"));
    gateReads(null, null);
    evalReturns(["correct", "50"]);
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: true, correct: true, points: 50 });
    // ...and the script still gets a real cooldown to enforce.
    expect(lastEval().argv[4]).toBe(CLASSIC_COOLDOWN_SEC * 1000);
    consoleError.mockRestore();
  });

  it("rejects a malformed challenge id and an empty flag before touching Upstash", async () => {
    expect(await submitFlag("alice", "../etc", "x")).toEqual({ ok: false, reason: "invalid" });
    expect(await submitFlag("alice", "chal-1", "   ")).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(evalCalls()).toHaveLength(0);
  });
});

describe("the grading script's arguments", () => {
  it("keys the grading call by the server-derived login, the challenge id, and every hash the script touches", async () => {
    await submitFlag("alice", "chal-1", "x");
    const { keys, argv } = lastEval();
    expect(keys).toEqual([
      "ctf:classic:attempts:alice",
      "ctf:classic:solves:alice",
      "ctf:classic:flagnorm",
      "ctf:classic:challenges",
      "ctf:classic:points",
      "ctf:classic:solvecount",
      "ctf:classic:solved",
      "ctf:classic:lastAt",
    ]);
    expect(argv[0]).toBe("chal-1");
    expect(argv[2]).toBe(new Date(Number(argv[5])).toISOString());
    expect(argv[3]).toBe("alice");
  });

  it("passes the CURRENT cooldown setting to the script, never a stored cutoff", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ classicCooldownSec: 30 }));
    await submitFlag("alice", "chal-1", "x");
    expect(lastEval().argv[4]).toBe(30_000);
  });

  it("falls back to the module default cooldown when no admin override is set", async () => {
    const before = Date.now();
    await submitFlag("alice", "chal-1", "x");
    const after = Date.now();
    const { argv } = lastEval();
    expect(argv[4]).toBe(CLASSIC_COOLDOWN_SEC * 1000);
    expect(Number(argv[5])).toBeGreaterThanOrEqual(before);
    expect(Number(argv[5])).toBeLessThanOrEqual(after);
  });

  it("passes 0 through as 'no cooldown' rather than falling back to the default", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ classicCooldownSec: 0 }));
    await submitFlag("alice", "chal-1", "x");
    expect(lastEval().argv[4]).toBe(0);
  });
});

describe("the grading script itself (text invariants)", () => {
  it("guards the already-solved check before ANY write, re-checks the cooldown before spending an attempt, and gates the counters behind the correctness check", async () => {
    await submitFlag("alice", "chal-1", "x");
    const { script } = lastEval();
    const missing = script.indexOf("'missing'");
    const guard = script.indexOf("HEXISTS");
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
    // The already-solved guard reads only the caller's own solves; the flag
    // hash (the `missing` read) comes after the story lock (CodeRabbit #470),
    // and still before anything is spent or written.
    expect(guard).toBeLessThan(missing);
    expect(missing).toBeLessThan(cooldownReturn);
    // The authoritative cooldown re-check happens after the already-solved
    // guard but strictly BEFORE any attempt is spent — a refusal writes
    // nothing. And because the guard precedes every increment, a login can
    // never bump the per-challenge solve counter twice.
    expect(guard).toBeLessThan(cooldownReturn);
    expect(cooldownReturn).toBeLessThan(attemptsWrite);
    expect(attemptsWrite).toBeLessThan(incorrectReturn);
    expect(incorrectReturn).toBeLessThan(solveWrite);
    expect(solveWrite).toBeLessThan(pointsIncr);
    expect(pointsIncr).toBeLessThan(solvedIncr);
    expect(solvedIncr).toBeLessThan(solveCountIncr);
  });

  it("compares the flag as a WHOLE VALUE, never parsed out of a JSON blob", async () => {
    await submitFlag("alice", "chal-1", "x");
    const { script } = lastEval();
    // The stored value IS the whole hash field: a flag routinely contains
    // braces, quotes and backslashes, so any in-script pattern match against a
    // blob containing one is an escaping bug.
    expect(script).toContain("local target = redis.call('HGET', KEYS[3], ARGV[1])");
    // Compared against ONE whole value. Which submitted form that is now
    // depends on the challenge (issue #193), so the comparison reads a local
    // rather than ARGV[2] directly — but it is still a whole-value `~=`, and
    // `target` itself is still never pattern-matched, which is the part that
    // would be an escaping bug.
    expect(script).toContain("if target ~= submitted then");
    expect(script).toMatch(/local submitted = ARGV\[2\]/);
    expect(script).not.toContain('string.match(target');
  });

  it("never normalizes in Lua — string.lower is ASCII-only and would disagree with normalizeFlag", async () => {
    await submitFlag("alice", "chal-1", "x");
    const { script } = lastEval();
    expect(script).not.toContain("string.lower");
    expect(script).not.toContain("string.upper");
  });

  it("anchors the attempts/lastAtMs/points pattern matches to a complete field", async () => {
    await submitFlag("alice", "chal-1", "x");
    const { script } = lastEval();
    expect(script).toContain(`'"attempts":(%d+)[,}]'`);
    expect(script).toContain(`'"lastAtMs":(%d+)[,}]'`);
    expect(script).toContain(`'"points":(%-?%d+)[,}]'`);
  });
});

describe("verdict mapping", () => {
  it("maps every script verdict to its result shape", async () => {
    evalReturns(["missing"]);
    expect(await submitFlag("a", "c", "x")).toEqual({ ok: false, reason: "invalid" });
    evalReturns(["incorrect", "2"]);
    expect(await submitFlag("a", "c", "x")).toEqual({ ok: true, correct: false });
    evalReturns(["already"]);
    expect(await submitFlag("a", "c", "x")).toEqual({ ok: true, correct: true, points: 0, already: true });
    evalReturns(["correct", "50"]);
    expect(await submitFlag("a", "c", "x")).toEqual({ ok: true, correct: true, points: 50 });
    evalReturns(["cooldown", "1770000000000"]);
    expect(await submitFlag("a", "c", "x")).toEqual({
      ok: false,
      reason: "cooldown",
      retryAt: new Date(1770000000000).toISOString(),
    });
  });

  it("maps the script's authoritative 'cooldown' verdict even when the pre-check allowed — this is what closes the parallel-submission race", async () => {
    // The pre-check sees no prior attempt (simulating N requests racing in
    // with the same stale read), but the script, which re-reads fresh one
    // submission at a time, has already seen another land.
    gateReads(null, null);
    const retryAtMs = Date.now() + 5_000;
    evalReturns(["cooldown", String(retryAtMs)]);
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({
      ok: false,
      reason: "cooldown",
      retryAt: new Date(retryAtMs).toISOString(),
    });
  });

  it("degrades to a friendly error when the script itself fails, or returns something unrecognised", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashEval.mockRejectedValueOnce(new Error("upstash down"));
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "error" });
    evalReturns(["who knows"]);
    expect(await submitFlag("alice", "chal-1", "x")).toEqual({ ok: false, reason: "error" });
    consoleError.mockRestore();
  });

  it("never echoes the submitted flag back in any result", async () => {
    evalReturns(["incorrect", "1"]);
    const res = await submitFlag("alice", "chal-1", "CTF{secret}");
    expect(JSON.stringify(res)).not.toContain("CTF{secret}");
    expect(JSON.stringify(res)).not.toContain("ctf{secret}");
  });
});

describe("failures never reach the log with the request attached (#244)", () => {
  const FLAG = "CTF{do-not-log-me}";
  // A driver that decorates its rejection with the request it failed on is the
  // whole danger: `upstashEval`'s ARGV carries BOTH comparison forms of the
  // submitted flag, so one `console.error(err)` writes the event's flags to
  // the log. The error's own `message` says nothing about them.
  const decorated = () =>
    Object.assign(new Error("Upstash EVAL failed: ERR timeout"), {
      command: ["EVAL", "...", FLAG, FLAG.toLowerCase()],
      cause: new Error(`while sending ${FLAG}`),
    });

  /** Asserts exactly one `console.error` whose args carry no Error object and
   *  no flag, but still say which failure it was. */
  function expectRedacted(spy: ReturnType<typeof vi.spyOn>, diagnostic: string) {
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0] as unknown[];
    expect(String(logged[0])).toContain(diagnostic);
    // Load-bearing half: `JSON.stringify(new Error("x"))` is `"{}"`, so the
    // string check alone passes against the unfixed code.
    expect(logged.some((arg) => arg instanceof Error)).toBe(false);
    const rendered = logged.map((arg) => JSON.stringify(arg)).join(" ");
    expect(rendered).not.toContain(FLAG);
    expect(rendered).not.toContain(FLAG.toLowerCase());
    expect(rendered).toContain("ERR timeout");
  }

  it("grading: logs a fixed diagnostic and the error's name/message, not the object", async () => {
    mocks.upstashEval.mockRejectedValueOnce(decorated());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await submitFlag("alice", "chal-1", FLAG)).toEqual({ ok: false, reason: "error" });
      expectRedacted(spy, "Classic grading failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("gate lookup: same redaction, and the gate still fails closed", async () => {
    mocks.upstashPipeline.mockRejectedValueOnce(decorated());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await submitFlag("alice", "chal-1", FLAG);
      expect(result.ok).toBe(false);
      expect(evalCalls()).toHaveLength(0);
      expectRedacted(spy, "solve/attempt lookup failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("admin settings read: same redaction, and scoring still fails open", async () => {
    mocks.getAdminSettings.mockRejectedValueOnce(decorated());
    evalReturns(["correct", "100"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await submitFlag("alice", "chal-1", FLAG)).toMatchObject({ ok: true });
      expectRedacted(spy, "admin settings read failed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("dry run (#464 admin preview)", () => {
  it("grades before launch: the not-launched pause is what is being previewed", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null }));
    evalReturns(["correct", "50", "dry"]);
    expect(await submitFlag("alice", "chal-1", "CTF{x}", { dryRun: true })).toEqual({
      ok: true,
      correct: true,
      points: 50,
      dryRun: true,
    });
    // The SAME script, told to write nothing.
    expect(lastEval().argv[7]).toBe("1");
  });

  it("ignores the cooldown pre-check, but still refuses an already-solved challenge", async () => {
    mocks.getAdminSettings.mockResolvedValue(settings({ classicCooldownSec: 60 }));
    gateReads(null, attemptRow(1, new Date(Date.now() - 1_000).toISOString()));
    evalReturns(["incorrect", "0", "dry"]);
    expect(await submitFlag("alice", "chal-1", "nope", { dryRun: true })).toEqual({ ok: true, correct: false, dryRun: true });

    gateReads(solveRow(50, "2026-08-19T10:00:00.000Z"), null);
    expect(await submitFlag("alice", "chal-1", "x", { dryRun: true })).toEqual({ ok: false, reason: "solved" });
  });

  it("a normal submission passes ARGV[8] = \"0\" (writes as always)", async () => {
    evalReturns(["correct", "50"]);
    expect(await submitFlag("alice", "chal-1", "CTF{x}")).toEqual({ ok: true, correct: true, points: 50 });
    expect(lastEval().argv[7]).toBe("0");
  });
});

describe("story lock (#463)", () => {
  const storiesReply = (steps: string[]) => [{ result: JSON.stringify([{ id: "op", title: "Op", intro: "", steps }]) }];

  it("hands the script the step's prerequisite, every teammate's (solves, user record) pair and the team", async () => {
    gateReads(null, null);
    mocks.upstashPipeline.mockResolvedValueOnce(storiesReply(["recon", "chal-1"]));
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["recon", "chal-1"] }]); // existing ids
    evalReturns(["correct", "50"]);
    await submitFlag("alice", "chal-1", "CTF{x}");
    const { keys, argv } = lastEval();
    expect(argv[8]).toBe("recon");
    // KEYS[9..] (index 8 on): KEYS[8] is the lastAt hash (#522).
    expect(keys[7]).toBe("ctf:classic:lastAt");
    expect(keys.slice(8)).toEqual(["ctf:classic:solves:alice", "ctf:user:alice", "ctf:classic:solves:bob", "ctf:user:bob"]);
    expect(argv[9]).toBe("red");
  });

  it("reports the script's `locked` exactly as an unknown challenge — no oracle, never a wrong answer", async () => {
    gateReads(null, null);
    mocks.upstashPipeline.mockResolvedValueOnce(storiesReply(["recon", "chal-1"]));
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["recon", "chal-1"] }]); // existing ids
    evalReturns(["locked"]);
    expect(await submitFlag("alice", "chal-1", "CTF{x}")).toEqual({ ok: false, reason: "invalid" });
  });

  // CodeRabbit #470: the TS cooldown pre-check ran BEFORE the story lock, so a
  // step that became locked (a reorder) while in cooldown answered `cooldown`
  // — a refusal an unknown id never gives. For a story step the pre-check is
  // left to the script, which checks the lock first.
  it("answers a locked step in cooldown like an unknown challenge, not with a cooldown", async () => {
    gateReads(null, JSON.stringify({ attempts: 1, lastAt: new Date().toISOString() }));
    mocks.upstashPipeline.mockResolvedValueOnce(storiesReply(["recon", "chal-1"]));
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["recon", "chal-1"] }]); // existing ids
    evalReturns(["locked"]);
    expect(await submitFlag("alice", "chal-1", "CTF{x}")).toEqual({ ok: false, reason: "invalid" });
    expect(evalCalls()).toHaveLength(1);
  });

  it("passes no prerequisite for step 1 or a challenge outside any story", async () => {
    gateReads(null, null);
    mocks.upstashPipeline.mockResolvedValueOnce(storiesReply(["chal-1", "web"]));
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["chal-1", "web"] }]); // existing ids
    evalReturns(["correct", "50"]);
    await submitFlag("alice", "chal-1", "CTF{x}");
    expect(lastEval().argv[8]).toBe("");
  });

  it("fails CLOSED when the stories cannot be read: `unavailable`, and the script never runs", async () => {
    gateReads(null, null);
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    expect(await submitFlag("alice", "chal-1", "CTF{x}")).toEqual({ ok: false, reason: "unavailable" });
    expect(evalCalls()).toHaveLength(0);
  });
});
