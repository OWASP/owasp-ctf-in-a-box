// hintBalance (hint-balance.ts) is what the hint gate's affordability check
// (#553) reads: the contestant's folded, all-module gross score and their
// fresh hint spend. It is its own module because the folded leaderboard
// imports hint-penalties, which imports the hint config — the store cannot
// import the fold without a cycle, so this leaf does, and the store imports
// this.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFoldedLeaderboard: vi.fn(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leaderboard/folded", () => ({ getFoldedLeaderboard: mocks.getFoldedLeaderboard }));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline }));

import { hintBalance } from "@/lib/hint-balance";

const board = (entries: Array<{ login: string; points: number; hintPenalty?: number }>) =>
  mocks.getFoldedLeaderboard.mockResolvedValue({ entries, teams: [] });
const spentReply = (v: string | null) => mocks.upstashPipeline.mockResolvedValue([{ result: v }]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hintBalance (#553)", () => {
  it("reads gross from the folded row and the spend fresh from ctf:hints:spent", async () => {
    board([{ login: "octocat", points: 50, hintPenalty: 10 }]);
    spentReply("10");
    expect(await hintBalance("octocat")).toEqual({ gross: 60, spent: 10, net: 50 });
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["HGET", "ctf:hints:spent", "octocat"]]);
  });

  it("uses the fresh spend when it is ahead of the cached fold (a purchase inside the TTL)", async () => {
    // The fold is memoized for ~10 s; a hint bought a second ago is in the
    // spend hash but not yet in the row's penalty. The fresh figure wins, or
    // two quick purchases could both pass on the same stale balance.
    board([{ login: "octocat", points: 50, hintPenalty: 10 }]);
    spentReply("25");
    expect(await hintBalance("octocat")).toEqual({ gross: 60, spent: 25, net: 35 });
  });

  it("keeps the fold's summed penalty when the fresh read is behind it (a case-variant login)", async () => {
    // hint-penalties sums the case variants of one login; HGET by the
    // session's spelling sees only one of them. The larger figure is the
    // truthful one — the two can never disagree in the other direction.
    board([{ login: "octocat", points: 50, hintPenalty: 30 }]);
    spentReply("10");
    expect(await hintBalance("octocat")).toEqual({ gross: 80, spent: 30, net: 50 });
  });

  it("reports a floored row as broke, never as owed its penalty back", async () => {
    // The board floors net at 0, so points 0 + penalty 30 is an UPPER bound
    // on gross (the true gross is somewhere below 30): net can only be ≤ 0.
    board([{ login: "octocat", points: 0, hintPenalty: 30 }]);
    spentReply("30");
    expect(await hintBalance("octocat")).toEqual({ gross: 30, spent: 30, net: 0 });
  });

  it("matches the login case-insensitively, like every other login join", async () => {
    board([{ login: "OctoCat", points: 40 }]);
    spentReply(null);
    expect(await hintBalance("octocat")).toEqual({ gross: 40, spent: 0, net: 40 });
  });

  it("is in the red for a contestant with spend but no row on the board", async () => {
    // No solves anywhere means no row; a hint bought earlier still counts
    // against them. Negative is the honest answer — the gate clamps for display.
    board([{ login: "someone-else", points: 40 }]);
    spentReply("10");
    expect(await hintBalance("octocat")).toEqual({ gross: 0, spent: 10, net: -10 });
  });

  it("rejects when the fold fails, so the gate fails closed", async () => {
    mocks.getFoldedLeaderboard.mockRejectedValue(new Error("scorer down"));
    await expect(hintBalance("octocat")).rejects.toThrow("scorer down");
  });

  it("rejects on a per-command spend read error rather than reading it as 0", async () => {
    // upstashPipeline does not throw on a per-command error (AGENTS.md); an
    // unchecked `.result` would turn NOAUTH into a free balance.
    board([{ login: "octocat", points: 40 }]);
    mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(hintBalance("octocat")).rejects.toThrow(/NOAUTH/);
  });
});
