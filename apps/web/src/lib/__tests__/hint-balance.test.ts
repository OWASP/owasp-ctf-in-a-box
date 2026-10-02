// hintBalance (hint-balance.ts) is what the hint gate's affordability check
// (#553) reads: the contestant's folded, all-module gross score, their fresh
// hint spend, and the score revision the gross was folded under. It is its
// own module because the folded leaderboard imports hint-penalties, which
// imports the hint config — the store cannot import the fold without a
// cycle, so this leaf does, and the store imports this.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFoldedLeaderboard: vi.fn(),
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leaderboard/folded", () => ({ getFoldedLeaderboard: mocks.getFoldedLeaderboard }));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import { hintBalance } from "@/lib/hint-balance";

const REV = "7";
const board = (entries: Array<{ login: string; points: number; hintPenalty?: number }>) =>
  mocks.getFoldedLeaderboard.mockResolvedValue({ entries, teams: [] });

/** Routes the two pipeline reads: GET of the score revision, HGETALL of
 *  ctf:hints:spent (a flat [field, value, …] list). */
const replies = { rev: REV as string | null, spent: [] as string[], spentError: undefined as string | undefined };
const spentReply = (...pairs: Array<[string, string]>) => {
  replies.spent = pairs.flat();
};

beforeEach(() => {
  vi.clearAllMocks();
  replies.rev = REV;
  replies.spent = [];
  replies.spentError = undefined;
  mocks.upstashPipeline.mockImplementation(async (cmds) => {
    const verb = String(cmds[0][0]);
    if (verb === "GET") return [{ result: replies.rev }];
    if (verb === "HGETALL") return replies.spentError ? [{ error: replies.spentError }] : [{ result: replies.spent }];
    throw new Error(`unexpected command ${verb}`);
  });
});

describe("hintBalance (#553)", () => {
  it("reads gross from the folded row and the spend fresh from ctf:hints:spent", async () => {
    board([{ login: "octocat", points: 50, hintPenalty: 10 }]);
    spentReply(["octocat", "10"]);
    expect(await hintBalance("octocat")).toEqual({ gross: 60, spent: 10, net: 50, rev: REV });
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["HGETALL", "ctf:hints:spent"]]);
  });

  it("folds FRESH, never from the process-local memo", async () => {
    // The memo's invalidation is process-local and the AWS module runs two
    // app tasks: a score-lowering write on one task never reaches the other's
    // memo, which could serve a pre-write gross for up to the TTL. A purchase
    // is rare and rate-limited, so the fold is paid for every time.
    board([{ login: "octocat", points: 50 }]);
    await hintBalance("octocat");
    expect(mocks.getFoldedLeaderboard).toHaveBeenCalledWith({ fresh: true });
  });

  it("reads the score revision BEFORE folding, and hands it back with the figures", async () => {
    // The revision is what the reveal script checks the gross against. Read
    // before the fold, so a write that lands DURING the fold moves the
    // revision past the one reported here and the script refuses the stale
    // gross — read after, it would vouch for a gross that predates the write.
    board([{ login: "octocat", points: 50 }]);
    replies.rev = "41";
    expect(await hintBalance("octocat")).toMatchObject({ rev: "41" });
    const getIdx = mocks.upstashPipeline.mock.calls.findIndex((c) => String(c[0][0][0]) === "GET");
    expect(getIdx).toBeGreaterThan(-1);
    expect(mocks.upstashPipeline.mock.invocationCallOrder[getIdx]).toBeLessThan(
      mocks.getFoldedLeaderboard.mock.invocationCallOrder[0],
    );
  });

  it("reports revision '0' when nothing has ever bumped it", async () => {
    board([{ login: "octocat", points: 50 }]);
    replies.rev = null;
    expect(await hintBalance("octocat")).toMatchObject({ rev: "0" });
  });

  it("uses the fresh spend when it is ahead of the cached fold (a purchase inside the TTL)", async () => {
    board([{ login: "octocat", points: 50, hintPenalty: 10 }]);
    spentReply(["octocat", "25"]);
    expect(await hintBalance("octocat")).toMatchObject({ gross: 60, spent: 25, net: 35 });
  });

  it("sums the case variants of one login, like the penalty fold does", async () => {
    // A case-only GitHub rename mid-event leaves one person's spend under
    // two fields. A single HGET by the session's spelling would see only one
    // of them — and a new purchase under that spelling could then pass on an
    // undercount even when the row's (summed) penalty was already larger.
    board([{ login: "octocat", points: 50, hintPenalty: 30 }]);
    spentReply(["Ada", "5"], ["OctoCat", "20"], ["octocat", "20"]); // octocat's 20 just grew from 10
    expect(await hintBalance("octocat")).toMatchObject({ gross: 80, spent: 40, net: 40 });
  });

  it("trusts the fresh sum even when it is BELOW the row's penalty (an admin reset of that player)", async () => {
    board([{ login: "octocat", points: 50, hintPenalty: 30 }]);
    spentReply();
    expect(await hintBalance("octocat")).toMatchObject({ gross: 80, spent: 0, net: 80 });
  });

  it("reports a floored row as broke, never as owed its penalty back", async () => {
    // The board floors net at 0, so points 0 + penalty 30 is an UPPER bound
    // on gross (the true gross is somewhere below 30): net can only be ≤ 0.
    board([{ login: "octocat", points: 0, hintPenalty: 30 }]);
    spentReply(["octocat", "30"]);
    expect(await hintBalance("octocat")).toMatchObject({ gross: 30, spent: 30, net: 0 });
  });

  it("matches the login case-insensitively, like every other login join", async () => {
    board([{ login: "OctoCat", points: 40 }]);
    expect(await hintBalance("octocat")).toMatchObject({ gross: 40, spent: 0, net: 40 });
  });

  it("is in the red for a contestant with spend but no row on the board", async () => {
    // No solves anywhere means no row; a hint bought earlier still counts
    // against them. Negative is the honest answer — the gate clamps for display.
    board([{ login: "someone-else", points: 40 }]);
    spentReply(["octocat", "10"]);
    expect(await hintBalance("octocat")).toMatchObject({ gross: 0, spent: 10, net: -10 });
  });

  it("rejects when the fold fails, so the gate fails closed", async () => {
    mocks.getFoldedLeaderboard.mockRejectedValue(new Error("scorer down"));
    await expect(hintBalance("octocat")).rejects.toThrow("scorer down");
  });

  it("rejects on a per-command spend read error rather than reading it as 0", async () => {
    // upstashPipeline does not throw on a per-command error (AGENTS.md); an
    // unchecked `.result` would turn NOAUTH into a free balance.
    board([{ login: "octocat", points: 40 }]);
    replies.spentError = "NOAUTH";
    await expect(hintBalance("octocat")).rejects.toThrow(/NOAUTH/);
  });

  it("rejects when the revision cannot be read — no revision, no vouching for the gross", async () => {
    board([{ login: "octocat", points: 40 }]);
    mocks.upstashPipeline.mockImplementation(async (cmds) =>
      String(cmds[0][0]) === "GET" ? [{ error: "NOAUTH" }] : [{ result: [] }],
    );
    await expect(hintBalance("octocat")).rejects.toThrow(/NOAUTH/);
  });
});
