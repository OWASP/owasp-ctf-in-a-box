// Per-contestant and per-team support operations (issue #168).
//
// These are the only destructive controls in the kit that act on ONE person,
// so the things worth pinning are the blast radius (does it touch anybody
// else?), the aggregate bookkeeping (the counters are NOT all keyed the same
// way), and the refusals that keep a team administrable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  // `error` is part of the shape: upstashPipeline reports a per-command
  // failure there, and the tests below drive exactly that (issue #358).
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));

vi.mock("server-only", () => ({}));
// `parseScanPage` is the REAL parser (pure: a reply in, a page or a throw
// out). Stubbing it here would put a local imitation under test instead of
// the one the store calls.
vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    assertPipelineOk: actual.assertPipelineOk,
    parseScanPage: actual.parseScanPage,
    upstashEval: mocks.upstashEval,
    upstashPipeline: mocks.upstashPipeline,
  };
});
vi.mock("@/lib/admin-store", () => ({ ADMIN_AUDIT_KEY: "ctf:admin:audit", AUDIT_CAP: 500 }));
// #553: a per-player reset lowers that player's score, and the hint gate
// reads gross from the fold memo; the store drops it through this leaf.
const foldCache = vi.hoisted(() => ({ invalidateFoldedLeaderboard: vi.fn() }));
vi.mock("@/lib/leaderboard/fold-cache", () => foldCache);

import {
  OpsValidationError,
  deleteUser,
  forceDisbandTeam,
  forceRemoveFromTeam,
  forceTransferCaptain,
  lookupUser,
  resetUserProgress,
} from "@/lib/admin-ops-store";

/** Reply for a pipeline of N commands, all zero/empty unless overridden. */
const replies = (...results: unknown[]) => results.map((result) => ({ result }));

/** lookupUser's first command is one HMGET of [team, joinedAt, firstTeamAt],
 *  so its reply is an ARRAY, not a scalar. Building it here keeps every
 *  fixture honest about that — an accidental scalar makes the store read no
 *  team at all and silently skips the follow-up pipeline, which then eats the
 *  NEXT test's queued reply. */
const userHmget = (
  slug: string | null,
  joinedAt: string | null = null,
  firstTeamAt: string | null = null,
) => [slug, joinedAt, firstTeamAt];

/** The SCAN over `ctf:solves:*` that the secure-dev walk does first. Queues an
 *  empty sweep: cursor "0", no keys. */
function mockNoSecureDevKeys() {
  mocks.upstashPipeline.mockResolvedValueOnce(replies(["0", []]));
}

/** A single-page SCAN returning one solves hash whose fields are `fields`. */
function mockSecureDevKeys(key: string, fields: string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce(replies(["0", [key]]));
  mocks.upstashPipeline.mockResolvedValueOnce(replies(fields));
}

/** Every command issued across every pipeline call, flattened. */
function allCommands(): (string | number)[][] {
  return mocks.upstashPipeline.mock.calls.flatMap((c) => c[0]);
}

/** `resetUserProgress` evaluates `RESET_MODULE_SOLVES_SCRIPT` twice, classic
 *  first then ai, before it touches quiz/hints. Queues the two results in
 *  that order. Each tuple is
 *  `[solvesRemoved, attemptsRemoved, pointsRemoved, solvedRemoved, decremented]`
 *  — the shape the script returns. */
function mockModuleResets(
  classic: [number, number, number, number, number],
  ai: [number, number, number, number, number],
) {
  mocks.upstashEval.mockResolvedValueOnce(classic);
  mocks.upstashEval.mockResolvedValueOnce(ai);
}

/** The plain quiz+hints pipeline `resetUserProgress` still issues after both
 *  module scripts: 2 DEL + 2 HDEL for quiz, 2 DEL + 1 HDEL for hints, then
 *  the HDEL of quiz's award time (#522). */
function mockQuizAndHintsPipeline() {
  mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1, 1, 1, 1, 1, 1, 1));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resetUserProgress invalidates the folded leaderboard (#553)", () => {
  it("drops the fold memo once, after the last write, so the hint gate cannot read the pre-reset gross", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    await resetUserProgress("octocat", "admin");
    expect(foldCache.invalidateFoldedLeaderboard).toHaveBeenCalledTimes(1);
    // After the writes, not before: an invalidation that runs first can be
    // refilled by a fold that still sees the old points.
    const lastWrite = Math.max(
      ...mocks.upstashPipeline.mock.invocationCallOrder,
      ...mocks.upstashEval.mock.invocationCallOrder,
    );
    expect(foldCache.invalidateFoldedLeaderboard.mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite);
  });

  it("drops the memo even when a later stage fails — the earlier destructive stages stand", async () => {
    // The secure-dev sweep ran; the classic module reset then throws. Those
    // solves are gone, so the memo must go too, before the error propagates.
    mockNoSecureDevKeys();
    mocks.upstashEval.mockRejectedValueOnce(new Error("eval down"));
    await expect(resetUserProgress("octocat", "admin")).rejects.toThrow("eval down");
    expect(foldCache.invalidateFoldedLeaderboard).toHaveBeenCalledTimes(1);
  });
});

describe("input validation", () => {
  it("refuses a login that is not a GitHub login", async () => {
    await expect(lookupUser("not a login!")).rejects.toBeInstanceOf(OpsValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("refuses a slug carrying a glob, before it can reach a key", async () => {
    // These keys are built by interpolation. An unvalidated slug is how a `*`
    // reaches a pattern or a `:` invents a key namespace.
    await expect(forceDisbandTeam("*", "admin")).rejects.toBeInstanceOf(OpsValidationError);
    await expect(forceDisbandTeam("a:b", "admin")).rejects.toBeInstanceOf(OpsValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("lookupUser", () => {
  it("reports a contestant with no team and no data as unknown", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("octocat");
    expect(detail.known).toBe(false);
    expect(detail.team).toBeNull();
  });

  it("counts only the target's fields in a shared secure-dev solves hash", async () => {
    // `ctf:solves:<target>` holds EVERY contestant's solves for that target,
    // keyed `<login>:<challengeId>`. Counting the whole hash would report
    // another team's work as this contestant's.
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockSecureDevKeys("ctf:solves:dvwa", ["octocat:c1", "octocat:c2", "mallory:c1"]);
    const detail = await lookupUser("octocat");
    expect(detail.secureDev.solves).toBe(2);
    expect(detail.known).toBe(true);
  });

  it("does not mistake a login PREFIX for the login", async () => {
    // "octo" must not match "octocat:c1". The `:` separator is what makes the
    // prefix exact, and LOGIN_RE guarantees a login cannot contain one.
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockSecureDevKeys("ctf:solves:dvwa", ["octocat:c1", "octo:c9"]);
    expect((await lookupUser("octo")).secureDev.solves).toBe(1);
  });

  it("sums attempts out of the JSON rows, not by coercing them to numbers", async () => {
    // The attempts hash stores a JSON OBJECT per item, not a count. Summing it
    // with `Number(value)` yields NaN — which, coerced through `|| 0`, made the
    // support tab report "Attempts 0" for every contestant on every event, and
    // report it confidently. Nothing caught it: while the demo seed wrote no
    // attempt rows at all, zero WAS the right answer for seeded data, so the
    // bug and the fixture agreed with each other.
    //
    // Upstash returns HGETALL as a flat [field, value, field, value] array.
    const quizAttempts = [
      "xss-basics",
      JSON.stringify({ attempts: 2, firstAt: "2026-08-22T10:00:00Z", lastAt: "2026-08-22T10:06:00Z" }),
      "csrf-defense",
      JSON.stringify({ attempts: 3, firstAt: "2026-08-22T11:00:00Z", lastAt: "2026-08-22T11:09:00Z" }),
    ];
    const classicAttempts = [
      "web-robots-only",
      JSON.stringify({ attempts: 4, firstAt: "2026-08-22T12:00:00Z", lastAt: "2026-08-22T12:20:00Z" }),
    ];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], quizAttempts, null, null, [], classicAttempts, null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("octocat");
    expect(detail.quiz.attempts).toBe(5);
    expect(detail.classic.attempts).toBe(4);
  });

  it("treats an unreadable attempt row as no attempts rather than throwing", async () => {
    // A support lookup runs mid-event, on live data, when something has
    // already gone wrong. One corrupt row must not take the whole lookup down.
    const rows = ["good", JSON.stringify({ attempts: 2 }), "corrupt", "{not json", "empty", ""];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], rows, null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    expect((await lookupUser("octocat")).quiz.attempts).toBe(2);
  });

  it("marks the captain of their team", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team", "2026-08-22T10:00:00Z", "2026-08-20T09:00:00Z"), [], [], "10", "1", [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", "Octocat"));
    mockNoSecureDevKeys();
    const detail = await lookupUser("octocat");
    // Captain comparison is case-insensitive: GitHub logins round-trip with
    // their original case, and the store lowercases.
    expect(detail.team).toEqual({
      slug: "red-team",
      name: "Red Team",
      captain: "Octocat",
      isCaptain: true,
      joinedAt: "2026-08-22T10:00:00Z",
    });
    // The funnel's conversion moment, and it is EARLIER than joinedAt here —
    // this contestant switched teams, and firstTeamAt is what must not move.
    expect(detail.firstTeamAt).toBe("2026-08-20T09:00:00Z");
  });
});

// Issue #358. The SCAN walk is only half of it: this function reports how much
// of a contestant's progress it removed, and that number came from the FIELDS
// it intended to delete rather than from the delete's own reply. A failed HDEL
// therefore told the organizer a contestant was cleared while their solves
// were still there to be scored.
describe("resetUserProgress: a failed secure-dev delete is not a clear", () => {
  it("rejects when the HDEL fails, rather than counting those fields as removed", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce(replies(["0", ["ctf:solves:juice-shop"]])) // SCAN page
      .mockResolvedValueOnce(replies(["octocat:sqli-1"])) // HKEYS
      .mockResolvedValueOnce([{ error: "READONLY You can't write against a read only replica." }]); // HDEL

    await expect(resetUserProgress("octocat", "admin")).rejects.toThrow(
      /command failed \(clear secure-dev solves\)/,
    );
  });

  it("rejects when the HKEYS fails, rather than reading it as 'nothing here'", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce(replies(["0", ["ctf:solves:juice-shop"]])) // SCAN page
      .mockResolvedValueOnce([{ error: "WRONGTYPE Operation against a key holding the wrong kind of value" }]);

    await expect(resetUserProgress("octocat", "admin")).rejects.toThrow(
      /command failed \(clear secure-dev solves\)/,
    );
  });
});

describe("resetUserProgress", () => {
  it("DECREMENTS the classic per-challenge solve counter instead of deleting by login", async () => {
    // ctf:classic:solvecount is HINCRBY'd by CHALLENGE ID, not by login —
    // unlike every other aggregate here. HDELing it by login would remove
    // nothing and leave each challenge still counting a contestant whose
    // solves are gone, so the per-challenge stats would drift up permanently,
    // once per reset. The count comes back through the script's own return
    // value now, not a JS-side HKEYS.
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 2], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit

    const result = await resetUserProgress("octocat", "admin");

    expect(result.cleared.classicSolveCountsDecremented).toBe(2);
    const [script, keys, argv] = mocks.upstashEval.mock.calls[0];
    expect(script).toMatch(/HINCRBY/);
    expect(keys).toEqual([
      "ctf:classic:solves:octocat",
      "ctf:classic:attempts:octocat",
      "ctf:classic:points",
      "ctf:classic:solved",
      "ctf:classic:solvecount",
      "ctf:classic:lastAt",
    ]);
    // Login only — never a solved id, and never a raw HDEL/DEL of the
    // solvecount key from JS. The script is the only thing that ever
    // touches it.
    expect(argv).toEqual(["octocat"]);
  });

  it("DECREMENTS the ai per-challenge solve counter instead of deleting by login", async () => {
    // ctf:ai:solvecount has the exact same per-CHALLENGE shape as classic's
    // ctf:classic:solvecount above — HDELing it by login would leave every ai
    // challenge still counting a contestant whose solves are gone.
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0], [1, 1, 1, 1, 2]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit

    const result = await resetUserProgress("octocat", "admin");

    expect(result.cleared.aiSolveCountsDecremented).toBe(2);
    const [script, keys, argv] = mocks.upstashEval.mock.calls[1];
    expect(script).toMatch(/HINCRBY/);
    expect(keys).toEqual([
      "ctf:ai:solves:octocat",
      "ctf:ai:attempts:octocat",
      "ctf:ai:points",
      "ctf:ai:solved",
      "ctf:ai:solvecount",
      "ctf:ai:lastAt",
    ]);
    expect(argv).toEqual(["octocat"]);
  });

  it("decides its decrements from the script's OWN runtime read, never a pre-read snapshot (regression)", async () => {
    // CodeRabbit round-2: reading solved ids in one request, then deleting
    // rows and decrementing solvecount by that SNAPSHOT in a later request,
    // leaves a window — a solve landing in between gets DELeted with no
    // matching decrement, and solvecount drifts up forever. The fix is that
    // resetModuleSolves no longer reads anything in JS at all: it hands the
    // script only the login, and the script's own HKEYS (at execution time,
    // inside the same atomic EVAL as the decrements) is what decides how
    // many challenges to decrement. Pin that shape directly: ARGV is ALWAYS
    // exactly [login] for both modules — a solved id must never appear in an
    // EVAL call, pre-read or otherwise, because there is no such read left
    // to produce one.
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 5], [1, 1, 1, 1, 3]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit

    const result = await resetUserProgress("octocat", "admin");

    // These numbers can only have come from the mocked script's return value
    // — there is no JS-side count for them to have come from instead.
    expect(result.cleared.classicSolveCountsDecremented).toBe(5);
    expect(result.cleared.aiSolveCountsDecremented).toBe(3);

    expect(mocks.upstashEval).toHaveBeenCalledTimes(2);
    for (const [, , argv] of mocks.upstashEval.mock.calls) {
      expect(argv).toEqual(["octocat"]);
    }
  });

  it("clears every per-login key and nobody else's", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 0], [1, 1, 1, 1, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("octocat", "admin");

    const touched = allCommands()
      .filter((c) => c[0] === "DEL" || c[0] === "HDEL")
      .map((c) => String(c[1]) + (c[0] === "HDEL" ? `#${c[2]}` : ""));
    expect(touched).toEqual([
      "ctf:quiz:answers:octocat",
      "ctf:quiz:attempts:octocat",
      "ctf:quiz:points#octocat",
      "ctf:quiz:answered#octocat",
      "ctf:user:octocat:hints",
      "ctf:hints:at:octocat",
      "ctf:hints:spent#octocat",
      // #522: the award time goes with the totals it orders.
      "ctf:quiz:lastAt#octocat",
    ]);
    // Classic's and ai's per-login keys are cleared through the atomic
    // scripts instead — assert those calls named exactly this login's keys.
    const evalKeys = mocks.upstashEval.mock.calls.map((c) => c[1]);
    expect(evalKeys).toEqual([
      [
        "ctf:classic:solves:octocat",
        "ctf:classic:attempts:octocat",
        "ctf:classic:points",
        "ctf:classic:solved",
        "ctf:classic:solvecount",
        "ctf:classic:lastAt",
      ],
      [
        "ctf:ai:solves:octocat",
        "ctf:ai:attempts:octocat",
        "ctf:ai:points",
        "ctf:ai:solved",
        "ctf:ai:solvecount",
        "ctf:ai:lastAt",
      ],
    ]);
  });

  it("clears the ai module's per-login progress — the gap this reset used to leave open", async () => {
    // Before the earlier fix, resetUserProgress cleared quiz+classic+
    // secure-dev+hints but touched zero ctf:ai:* keys, so an ai solve
    // silently survived the "put them back to zero" lever. Assert the counts
    // round-trip through `cleared`, field-swapped from the classic
    // assertions above.
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 0], [3, 2, 40, 1, 1]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    const result = await resetUserProgress("octocat", "admin");

    expect(result.cleared.aiSolves).toBe(3);
    expect(result.cleared.aiAttempts).toBe(2);
    expect(result.cleared.aiAggregates).toBe(41);
    expect(result.cleared.aiSolveCountsDecremented).toBe(1);

    const [, aiKeys, aiArgv] = mocks.upstashEval.mock.calls[1];
    expect(aiKeys).toEqual([
      "ctf:ai:solves:octocat",
      "ctf:ai:attempts:octocat",
      "ctf:ai:points",
      "ctf:ai:solved",
      "ctf:ai:solvecount",
      "ctf:ai:lastAt",
    ]);
    expect(aiArgv).toEqual(["octocat"]);
  });

  it("does not touch another login's ai progress", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("octocat", "admin");

    const [, aiKeys, aiArgv] = mocks.upstashEval.mock.calls[1];
    expect(aiKeys).not.toContain("ctf:ai:solves:mallory");
    expect(aiArgv).not.toContain("mallory");
  });

  it("never touches the module-wide launch keypair, nonces, or the ai catalogue", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 0], [1, 1, 1, 1, 1]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("octocat", "admin");

    const cmds = allCommands();
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:ai:launchkey"))).toBe(false);
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:ai:nonce:"))).toBe(false);
    expect(cmds.some((c) => String(c[1]) === "ctf:ai:challenges")).toBe(false);
    const aiKeys = mocks.upstashEval.mock.calls[1][1] as string[];
    expect(
      aiKeys.some(
        (k) => k.startsWith("ctf:ai:launchkey") || k.startsWith("ctf:ai:nonce:") || k === "ctf:ai:challenges",
      ),
    ).toBe(false);
  });

  it("leaves the account and team membership alone", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("octocat", "admin");

    const cmds = allCommands();
    expect(cmds).not.toContainEqual(["DEL", "ctf:user:octocat"]);
    expect(cmds.some((c) => c[0] === "SREM")).toBe(false);
  });

  it("WARNS that secure-dev solves come back, rather than pretending", async () => {
    // The scorer writes them with HSETNX so replays no-op, and the poller
    // re-submits from PR comments — so these return on the next re-score.
    // Silence here would be a lie the organizer only discovers later.
    mockSecureDevKeys("ctf:solves:dvwa", ["octocat:c1"]);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1)); // HDEL of those fields
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    const result = await resetUserProgress("octocat", "admin");
    expect(result.cleared.secureDevSolves).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/HSETNX|re-ingest/i);
  });

  it("says nothing about secure-dev when there was none to clear", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    expect((await resetUserProgress("octocat", "admin")).warnings).toEqual([]);
  });

  it("writes an audit line naming the actor AND the target", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("octocat", "alice");

    const push = allCommands().find((c) => c[0] === "LPUSH" && c[1] === "ctf:admin:audit");
    const line = JSON.parse(String(push?.[2])) as Record<string, unknown>;
    expect(line.by).toBe("alice");
    expect(line.login).toBe("octocat");
    expect(line.action).toBe("ops:user-reset");
  });
});

describe("deleteUser", () => {
  it("refuses to delete a captain, naming the way out", async () => {
    // Deleting the captain would leave a team nobody can administer: rename,
    // remove, regenerate and disband are all captain-only.
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", "octocat"));
    mockNoSecureDevKeys();

    await expect(deleteUser("octocat", "admin")).rejects.toThrow(/captain/i);
    // and nothing was cleared on the way to that refusal
    expect(allCommands().some((c) => c[0] === "DEL")).toBe(false);
  });

  it("removes the membership and the account record", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", "alice"));
    mockNoSecureDevKeys();
    mockNoSecureDevKeys(); // the reset's own sweep
    mockModuleResets([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // SREM + DEL
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // delete audit

    const result = await deleteUser("octocat", "admin");
    expect(result.leftTeam).toBe("red-team");
    const cmds = allCommands();
    expect(cmds).toContainEqual(["SREM", "ctf:team:red-team:members", "octocat"]);
    expect(cmds).toContainEqual(["DEL", "ctf:user:octocat"]);
    // #553: the inner reset drops the fold memo, but the delete writes more
    // afterwards (membership, account record), so it drops it again after
    // ITS last write — a fold racing the tail end must not be memoized.
    const drops = foldCache.invalidateFoldedLeaderboard.mock.invocationCallOrder;
    expect(drops).toHaveLength(2);
    expect(drops[1]).toBeGreaterThan(Math.max(...mocks.upstashPipeline.mock.invocationCallOrder));
  });
});

describe("team overrides", () => {
  it("refuses to remove the captain", async () => {
    mocks.upstashEval.mockResolvedValueOnce("is-captain");
    await expect(forceRemoveFromTeam("red-team", "octocat", "admin")).rejects.toThrow(/captain/i);
  });

  it("refuses to remove someone who is not on the team", async () => {
    mocks.upstashEval.mockResolvedValueOnce("not-member");
    await expect(forceRemoveFromTeam("red-team", "octocat", "admin")).rejects.toThrow(/not on/i);
  });

  it("clears the user's team pointer in the SAME script as the SREM", async () => {
    // A member set and the ctf:user:<login> hash that points at it must not be
    // able to disagree, so the two writes are one atomic step — the same rule
    // team-store's own captain actions follow.
    mocks.upstashEval.mockResolvedValueOnce("ok");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    await forceRemoveFromTeam("red-team", "octocat", "admin");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("SREM");
    expect(script).toContain("HDEL");
  });

  it("will not hand a team to someone who is not a member", async () => {
    mocks.upstashEval.mockResolvedValueOnce("not-member");
    await expect(forceTransferCaptain("red-team", "outsider", "admin")).rejects.toThrow(/not on/i);
  });

  it("checks membership INSIDE the transfer script, not before it", async () => {
    mocks.upstashEval.mockResolvedValueOnce("ok");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    await forceTransferCaptain("red-team", "bob", "admin");
    const [script, keys] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("SISMEMBER");
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:red-team:members"]);
  });

  it("disband releases every member and kills the join code", async () => {
    // A surviving reverse index keeps resolving to a team that no longer
    // exists, and /join/<code> would render a card for a ghost.
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, ["alice", "bob"], "ABC123"));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1, 1, 1));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    const result = await forceDisbandTeam("red-team", "admin");
    expect(result.members).toBe(2);
    const cmds = allCommands();
    expect(cmds).toContainEqual(["HDEL", "ctf:user:alice", "team", "joinedAt"]);
    expect(cmds).toContainEqual(["HDEL", "ctf:user:bob", "team", "joinedAt"]);
    expect(cmds).toContainEqual(["DEL", "ctf:joincode:abc123"]);
  });

  it("disband does NOT delete anyone's progress", async () => {
    // Solves are per login, so a disbanded team's players keep what they
    // earned and can regroup. Deleting their work because the team was wrong
    // would turn an admin convenience into a scoring incident.
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, ["alice"], "ABC123"));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1, 1));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await forceDisbandTeam("red-team", "admin");
    const cmds = allCommands();
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:classic:solves:"))).toBe(false);
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:quiz:answers:"))).toBe(false);
  });

  it("refuses to disband a team that does not exist", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(replies(0, [], null));
    await expect(forceDisbandTeam("ghost", "admin")).rejects.toThrow(/No team/);
  });
});

// UX audit F4: `lookupUser` read quiz, classic and secure-dev and nothing for
// ai, so the Support card showed no AI figures for a contestant with AI
// solves, and the reset confirm summed a total the reset then exceeded. The
// ai reads are appended AFTER the existing eleven replies, so every fixture
// above stays valid: a missing tail reads as "no ai data", never as a shifted
// hint count.
describe("lookupUser — ai", () => {
  it("reports ai solves, points and attempts, and counts them toward known", async () => {
    const aiSolves = ["prompt-smuggling-qzl4ws", JSON.stringify({ at: "2026-09-03T01:49:00Z" })];
    const aiAttempts = [
      "prompt-smuggling-qzl4ws",
      JSON.stringify({ attempts: 4, firstAt: "2026-09-03T01:40:00Z", lastAt: "2026-09-03T01:49:00Z" }),
    ];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null, aiSolves, aiAttempts, "550", "1"),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("octocat");
    expect(detail.ai).toEqual({ solved: 1, points: 550, attempts: 4 });
    expect(detail.known).toBe(true);
    const cmds = allCommands();
    expect(cmds).toContainEqual(["HGETALL", "ctf:ai:solves:octocat"]);
    expect(cmds).toContainEqual(["HGETALL", "ctf:ai:attempts:octocat"]);
    expect(cmds).toContainEqual(["HGET", "ctf:ai:points", "octocat"]);
    expect(cmds).toContainEqual(["HGET", "ctf:ai:solved", "octocat"]);
  });
});

// CodeRabbit on #274: `known` counted solves and hints but never attempts, so
// a contestant who had tried and never solved read as "no data — check the
// spelling". Applies to every module's attempts, not only ai's.
describe("lookupUser — known", () => {
  it("counts a contestant with attempts but no solves as known", async () => {
    const aiAttempts = ["guardrail-bypass", JSON.stringify({ attempts: 2, firstAt: "2026-09-03T01:40:00Z", lastAt: "2026-09-03T01:41:00Z" })];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null, [], aiAttempts, null, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("octocat");
    expect(detail.ai.attempts).toBe(2);
    expect(detail.known).toBe(true);

    const quizAttempts = ["xss-basics", JSON.stringify({ attempts: 1, firstAt: "2026-09-03T01:40:00Z", lastAt: "2026-09-03T01:40:00Z" })];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], quizAttempts, null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    expect((await lookupUser("octocat")).known).toBe(true);
  });
});
