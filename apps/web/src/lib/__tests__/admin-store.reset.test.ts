import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(s: string, k: string[], a: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  beginScoreLowering: vi.fn(),
  endScoreLowering: vi.fn(),
}));
vi.mock("server-only", () => ({}));
// #553: the reset lowers scores. It brackets its writes with the leaf's
// begin/end — a shared in-progress marker + revision bump — so no app task
// charges a hint against a gross the wipe is removing (admin-store cannot
// import the fold itself: it is upstream of it).
vi.mock("@/lib/leaderboard/fold-cache", () => ({
  beginScoreLowering: mocks.beginScoreLowering,
  endScoreLowering: mocks.endScoreLowering,
}));
// `parseScanPage` is the REAL parser — see the note in team-store.test.ts.
vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    assertPipelineOk: actual.assertPipelineOk,
    parseScanPage: actual.parseScanPage,
    upstashEval: mocks.upstashEval,
    upstashPipeline: mocks.upstashPipeline,
  };
});

import { RESET_BEGIN_SCRIPT, RESET_PREFIXES, RESET_SCRIPT, resetEvent } from "@/lib/admin-store";
import { ALICE, actor } from "./audit-actor";
import { ANNOUNCE_WEBHOOK_GENERATION_KEY } from "@/lib/announce/keys";

beforeEach(() => {
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockReset();
  mocks.beginScoreLowering.mockReset();
  mocks.endScoreLowering.mockReset();
  mocks.upstashEval.mockResolvedValue([]);
});

// Route each pipeline command: SCAN returns [cursor, keys], DEL returns a count.
function pipelineImpl(scanKeys: (pattern: string) => string[][]) {
  const pages = new Map<string, string[][]>();
  return async (cmds: (string | number)[][]) => {
    const cmd = cmds[0];
    const verb = String(cmd[0]);
    if (verb === "SCAN") {
      const pattern = String(cmd[3]);
      if (!pages.has(pattern)) pages.set(pattern, scanKeys(pattern));
      const remaining = pages.get(pattern)!;
      const batch = remaining.shift() ?? [];
      const cursor = remaining.length > 0 ? "7" : "0";
      return [{ result: [cursor, batch] }];
    }
    if (verb === "DEL") return [{ result: cmd.length - 1 }];
    return [{ result: null }];
  };
}

/** The final freeze + audit eval's [script, keys, args]. */
const finalEval = () => mocks.upstashEval.mock.calls.find((c) => c[0] === RESET_SCRIPT)!;

describe("resetEvent", () => {
  // #553 review: the wipe lowers every score, and the hint gate reads gross
  // from the fold memo (~10 s). Without this a reset contestant could buy a
  // hint against their pre-reset points. After the LAST write, not before —
  // an invalidation that runs first can be refilled by a fold that still
  // sees the old keys.
  // Bumped BEFORE the first write and AFTER the last. Before: a hint fold
  // that read the old points under revision R must find R already moved by
  // the time its charge reaches the script, however long the wipe takes.
  // After: a fold that started mid-wipe read a mix, and the trailing bump
  // outdates it too. One bump at either end alone leaves a window.
  it("opens the score-lowering bracket before the first delete and closes it after the audit eval", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    await resetEvent(actor("alice"));
    expect(mocks.beginScoreLowering).toHaveBeenCalledTimes(1);
    expect(mocks.endScoreLowering).toHaveBeenCalledTimes(1);
    const writes = [...mocks.upstashPipeline.mock.invocationCallOrder, ...mocks.upstashEval.mock.invocationCallOrder];
    expect(mocks.beginScoreLowering.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...writes));
    expect(mocks.endScoreLowering.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...writes));
  });

  it("still closes the bracket when the freeze/audit eval throws — the prefix deletes already stand", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    mocks.upstashEval.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("down"));
    await expect(resetEvent(actor("alice"))).rejects.toThrow("down");
    expect(mocks.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  it("ABORTS before any prefix sweep when the webhook generation bump fails — fail closed", async () => {
    // The old generation must not stay active against a wiped outbox, so a
    // failed INCR stops the reset before the first SCAN/DEL.
    mocks.upstashPipeline.mockImplementation(async (cmds) => {
      const cmd = cmds[0];
      if (String(cmd[0]) === "INCR") return [{ error: "NOAUTH" }];
      return [{ result: [] }];
    });
    await expect(resetEvent(actor("alice"))).rejects.toThrow(/reset webhook generation/);
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    expect(commands.some((cmd) => cmd[0] === "SCAN" || cmd[0] === "DEL")).toBe(false);
    for (const [, pattern] of RESET_PREFIXES) {
      expect(commands.some((cmd) => cmd[0] === "SCAN" && cmd[3] === pattern)).toBe(false);
    }
    expect(mocks.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  it("ABORTS before any delete when the bracket cannot be opened — fail closed", async () => {
    // Without the marker another app task still sees the old revision and
    // no in-progress flag, and could charge a hint against a gross this
    // wipe is about to remove. Nothing may be deleted in that state.
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    mocks.beginScoreLowering.mockRejectedValue(new Error("upstash down"));
    await expect(resetEvent(actor("alice"))).rejects.toThrow("upstash down");
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(mocks.endScoreLowering).not.toHaveBeenCalled();
  });

  it("wipes every event-data prefix, then freezes + audits in one eval", async () => {
    // two keys for every prefix, single SCAN page each
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1", "k2"]]));

    const out = await resetEvent(actor("alice"));

    expect(out.cleared).toEqual({
      solves: 2,
      teams: 2,
      users: 2,
      joinCodes: 2,
      sdHeld: 2,
      relinkBlock: 2,
      hints: 2,
      quizAnswers: 2,
      quizAttempts: 2,
      quizPoints: 2,
      quizAnswered: 2,
      quizLastAt: 2,
      classicSolves: 2,
      classicAttempts: 2,
      classicPoints: 2,
      classicSolved: 2,
      classicSolveCount: 2,
      classicLastAt: 2,
      classicOpened: 2,
      activity: 2,
      announcements: 2,
      sponsors: 2,
      sponsorsLogo: 2,
      adjustments: 2,
    });
    expect(out.resetAt).toMatch(/^\d+$/);

    // one SCAN + one DEL per prefix (23 prefixes) = 46 pipeline calls
    const verbs = mocks.upstashPipeline.mock.calls.map((c) => c[0][0][0]);
    expect(verbs.filter((v) => v === "SCAN").length).toBe(23);
    expect(verbs.filter((v) => v === "DEL").length).toBe(23);
    // every wiped prefix, and NOT settings/audit/sync
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).toEqual([
      "ctf:solves:*",
      "ctf:team:*",
      "ctf:user:*",
      "ctf:joincode:*",
      "ctf:sd:held:*",
      "ctf:relink:*",
      "ctf:hints:*",
      "ctf:quiz:answers:*",
      "ctf:quiz:attempts:*",
      "ctf:quiz:points",
      "ctf:quiz:answered",
      "ctf:quiz:lastAt",
      "ctf:classic:solves:*",
      "ctf:classic:attempts:*",
      "ctf:classic:points",
      "ctf:classic:solved",
      "ctf:classic:solvecount",
      "ctf:classic:lastAt",
      "ctf:classic:opened:*",
      "ctf:activity:log",
      "ctf:announce:*",
      "ctf:sponsors",
      "ctf:sponsors:logo",
      "ctf:adjustments",
    ]);

    // the freeze + audit eval: settings + audit keys, and a reset audit line
    expect(mocks.upstashEval.mock.calls.map((c) => c[0])).toEqual([RESET_BEGIN_SCRIPT, RESET_SCRIPT]);
    const [script, keys, args] = finalEval();
    expect(script).toContain("'paused', '1'");
    expect(keys).toEqual([
      "ctf:admin:settings",
      "ctf:admin:audit",
      "ctf:admin:pauses",
      "ctf:admin:discord:webhook-generation",
      "ctf:announce:milestone",
    ]);
    expect(args[0]).toBe("alice"); // updatedBy: the actor's name
    const auditLine = JSON.parse(String(args[3]));
    expect(auditLine).toMatchObject({ by: ALICE.id, name: "alice", action: "reset", cleared: { solves: 2, teams: 2 } });
  });

  // The scorer's solve script refuses a score timed before the CURRENT
  // `resetAt`, read in the same EVAL as its write. The epoch therefore lands
  // before any solve is swept, or a score judged before the reset could be
  // written after the sweep and survive it.
  it("writes the reset epoch, the freeze and a start audit line before the first SCAN, and the same epoch in the final eval", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    const out = await resetEvent(actor("alice"));
    const begin = mocks.upstashEval.mock.calls.findIndex((c) => c[0] === RESET_BEGIN_SCRIPT);
    expect(begin).toBe(0);
    const firstScan = mocks.upstashPipeline.mock.calls.findIndex((c) => c[0][0][0] === "SCAN");
    expect(mocks.upstashEval.mock.invocationCallOrder[begin]).toBeLessThan(mocks.upstashPipeline.mock.invocationCallOrder[firstScan]);
    const [script, keys, args] = mocks.upstashEval.mock.calls[begin];
    expect(keys).toEqual(["ctf:admin:settings", "ctf:admin:audit"]);
    expect(script).toContain("'paused', '1', 'pausedSince', ARGV[2], 'resetAt', ARGV[3]");
    expect(script).toContain("redis.call('LPUSH', KEYS[2], ARGV[4])");
    expect(args[0]).toBe("alice");
    expect(args[2]).toBe(out.resetAt);
    expect(JSON.parse(String(args[3]))).toMatchObject({ by: ALICE.id, name: "alice", action: "reset:start", at: args[1] });
    const [, , finalArgs] = finalEval();
    expect(finalArgs[1]).toBe(args[1]);
    expect(finalArgs[2]).toBe(out.resetAt);
  });

  it("deletes nothing when the epoch write fails", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    mocks.upstashEval.mockRejectedValueOnce(new Error("READONLY"));
    await expect(resetEvent(actor("alice"))).rejects.toThrow("READONLY");
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.upstashEval).toHaveBeenCalledTimes(1);
    expect(mocks.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  // #464: a master reset returns the event to NOT LAUNCHED — the scoring
  // start is cleared in the same atomic script that freezes and audits.
  it("relocks the event: clears scoringStartsAt in the same eval", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [[]]));
    await resetEvent(actor("alice"));
    const [script] = finalEval();
    expect(script).toMatch(/redis\.call\('HDEL', KEYS\[1\], 'scoringStartsAt'\)/);
  });

  // The reset starts a fresh pause log: the old event's intervals go, and the
  // freeze the reset sets is open from the reset instant.
  it("clears the pause log and opens the reset's own freeze in the same eval", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [[]]));
    await resetEvent(actor("alice"));
    const [script, keys, args] = finalEval();
    expect(keys[2]).toBe("ctf:admin:pauses");
    expect(script).toMatch(/redis\.call\('DEL', KEYS\[3\]\)/);
    expect(script).toContain("'pausedSince', ARGV[2]");
    expect(typeof args[1]).toBe("string");
  });

  it("wipes quiz answers and attempts", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).toContain("ctf:quiz:answers:*");
    expect(patterns).toContain("ctf:quiz:attempts:*");
  });

  // #590: the webhook + switches are ORGANIZER CONFIGURATION (their own
  // `ctf:admin:discord*` keys, outside every reset prefix and absent from
  // the freeze/audit eval); only the announcement PROGRESS under
  // `ctf:announce:*` is event data a reset wipes. Losing the webhook on a
  // reset would silently disconnect an event the organizer already wired up.
  it("KEEPS the Discord webhook configuration across a reset, while wiping announcement state", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).toContain("ctf:announce:*");
    expect(patterns).not.toContain("ctf:admin:discord");
    expect(patterns).not.toContain("ctf:admin:discord:webhook");
    expect(patterns).not.toContain(ANNOUNCE_WEBHOOK_GENERATION_KEY);
    const [, evalKeys] = mocks.upstashEval.mock.calls[0];
    expect(evalKeys).not.toContain("ctf:admin:discord");
    expect(evalKeys).not.toContain("ctf:admin:discord:webhook");
  });

  it("KEEPS the question bank and the answer key across a reset", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).not.toContain("ctf:quiz:questions");
    expect(patterns).not.toContain("ctf:quiz:key");
  });

  it("also clears the quiz aggregate totals", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    const out = await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).toContain("ctf:quiz:points");
    expect(patterns).toContain("ctf:quiz:answered");
    expect(out.cleared.quizPoints).toBe(1);
    expect(out.cleared.quizAnswered).toBe(1);
  });

  it("wipes classic solves and attempts", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).toContain("ctf:classic:solves:*");
    expect(patterns).toContain("ctf:classic:attempts:*");
  });

  it("KEEPS the classic challenge bank, flag key, and categories across a reset", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).not.toContain("ctf:classic:challenges");
    expect(patterns).not.toContain("ctf:classic:flag");
    expect(patterns).not.toContain("ctf:classic:flagnorm");
    expect(patterns).not.toContain("ctf:classic:categories");
  });

  it("also clears the classic aggregate totals", async () => {
    mocks.upstashPipeline.mockImplementation(pipelineImpl(() => [["k1"]]));
    const out = await resetEvent(actor("alice"));
    const patterns = mocks.upstashPipeline.mock.calls
      .filter((c) => c[0][0][0] === "SCAN")
      .map((c) => c[0][0][3]);
    expect(patterns).toContain("ctf:classic:points");
    expect(patterns).toContain("ctf:classic:solved");
    expect(patterns).toContain("ctf:classic:solvecount");
    expect(out.cleared.classicPoints).toBe(1);
    expect(out.cleared.classicSolved).toBe(1);
    expect(out.cleared.classicSolveCount).toBe(1);
  });

  // Issue #358, and the most dangerous of the five walks that shared the bug.
  // A failed SCAN page used to be read as cursor "0" — iteration complete — so
  // the sweep stopped early and `resetEvent` still returned a cleared COUNT.
  // An organizer would be told the event was wiped, then open a "fresh" one
  // still holding last event's solves, with nothing having reported a problem.
  //
  // The failure lands on the SECOND page on purpose: a first-page failure
  // cleared 0 and looked plausible, but the truncation only becomes invisible
  // once some keys have already been deleted.
  it("rejects when a SCAN page fails mid-sweep, rather than reporting a partial wipe as done", async () => {
    let scans = 0;
    mocks.upstashPipeline.mockImplementation(async (cmds: (string | number)[][]) => {
      const cmd = cmds[0];
      if (String(cmd[0]) === "SCAN") {
        scans += 1;
        // Page 1 succeeds and reports more to come; page 2 fails.
        if (scans === 1) return [{ result: ["7", ["ctf:solves:juice-shop"]] }];
        return [{ error: "ERR max requests limit exceeded" }];
      }
      if (String(cmd[0]) === "DEL") return [{ result: cmd.length - 1 }];
      return [{ result: null }];
    });

    await expect(resetEvent(actor("alice"))).rejects.toThrow(/SCAN failed \(reset /);
  });

  // The other half of #358, and the one CodeRabbit's review caught: making the
  // SCAN honest is pointless if the DEL that follows it can fail silently.
  // `total` is incremented from `keys.length`, not from the DEL's reply, so an
  // unchecked failure reported keys as cleared that are demonstrably still
  // there — the same false "done", one command later.
  it("rejects when a DEL fails, rather than counting those keys as cleared", async () => {
    mocks.upstashPipeline.mockImplementation(async (cmds: (string | number)[][]) => {
      const cmd = cmds[0];
      if (String(cmd[0]) === "SCAN") return [{ result: ["0", ["ctf:solves:juice-shop"]] }];
      if (String(cmd[0]) === "DEL") return [{ error: "READONLY You can't write against a read only replica." }];
      return [{ result: null }];
    });

    await expect(resetEvent(actor("alice"))).rejects.toThrow(/command failed \(reset /);
  });

  it("skips DEL for an empty prefix and paginates a multi-page prefix", async () => {
    mocks.upstashPipeline.mockImplementation(
      pipelineImpl((pattern) =>
        pattern === "ctf:solves:*" ? [["a"], ["b", "c"]] : pattern === "ctf:team:*" ? [[]] : [["x"]],
      ),
    );

    const out = await resetEvent(actor("bob"));

    expect(out.cleared.solves).toBe(3); // 1 + 2 across two SCAN pages
    expect(out.cleared.teams).toBe(0); // empty -> no DEL
    // teams issued a SCAN but no DEL
    const teamDels = mocks.upstashPipeline.mock.calls.filter(
      (c) => c[0][0][0] === "DEL" && (c[0][0] as unknown[]).includes("ctf:team:*"),
    );
    expect(teamDels.length).toBe(0);
  });
});
