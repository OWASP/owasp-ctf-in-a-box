// #595: the board counts TEAMS that solved a challenge, not players. Scoring
// is per team, so two members solving one flag count once; a teamless solver
// is not counted. Derived from current members' solves at read time, never
// stored, so a team change cannot leave it stale.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ upstashPipeline: vi.fn(), listTeams: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: m.upstashPipeline }));
vi.mock("@/lib/team-store", () => ({ listTeams: m.listTeams }));

import { teamSolveBoard, teamSolveCounts } from "@/lib/team-solve-counts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("teamSolveCounts", () => {
  it("counts each team once per challenge, however many members solved it", async () => {
    m.listTeams.mockResolvedValue([
      { slug: "red", name: "Red", members: ["alice", "bob"] },
      { slug: "blue", name: "Blue", members: ["carol"] },
    ]);
    m.upstashPipeline.mockResolvedValue([{ result: ["recon", "web"] }, { result: ["recon"] }, { result: ["recon"] }]);
    expect(await teamSolveCounts("classic")).toEqual(new Map([["recon", 2], ["web", 1]]));
    expect(m.upstashPipeline.mock.calls[0][0]).toEqual([
      ["HKEYS", "ctf:classic:solves:alice"],
      ["HKEYS", "ctf:classic:solves:bob"],
      ["HKEYS", "ctf:classic:solves:carol"],
    ]);
  });

  it("reads the AI module's solves for ai", async () => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice"] }]);
    m.upstashPipeline.mockResolvedValue([{ result: ["jail-1"] }]);
    expect(await teamSolveCounts("ai")).toEqual(new Map([["jail-1", 1]]));
    expect(m.upstashPipeline.mock.calls[0][0]).toEqual([["HKEYS", "ctf:ai:solves:alice"]]);
  });

  it("is empty with no teams, without reading any solves", async () => {
    m.listTeams.mockResolvedValue([]);
    expect(await teamSolveCounts("classic")).toEqual(new Map());
    expect(m.upstashPipeline).not.toHaveBeenCalled();
  });

  // A count that is silently short reads as a real one; no count at all does
  // not. The board renders nothing for a null.
  // A reply that is missing, or is not a list, is a read that did not
  // happen; read as "no solves" it is a short count that looks real.
  it.each([
    ["a missing reply", [{ result: ["recon"] }]],
    ["a non-list result", [{ result: ["recon"] }, { result: "recon" }]],
  ])("is null for %s, never a short count", async (_what, replies) => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice", "bob"] }]);
    m.upstashPipeline.mockResolvedValue(replies);
    expect(await teamSolveCounts("classic")).toBeNull();
  });

  it("is null when a read fails, never a short count", async () => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice", "bob"] }]);
    m.upstashPipeline.mockResolvedValue([{ result: ["recon"] }, { error: "NOAUTH" }]);
    expect(await teamSolveCounts("classic")).toBeNull();
    m.listTeams.mockRejectedValue(new Error("SCAN failed"));
    expect(await teamSolveCounts("classic")).toBeNull();
  });
});

// #188: first blood rides on the same read as the board's team counts — the
// members' own solve rows, never a stored marker — so it cannot drift from
// them, and anything that removes a solve row or a membership removes it.
describe("teamSolveBoard", () => {
  /** HGETALL's flat reply for a solves hash: id, row, id, row, ... */
  const solves = (...rows: [string, string][]) => rows.flatMap(([id, iso]) => [id, JSON.stringify({ points: 10, at: iso })]);
  const T1 = "2026-10-01T12:00:01.000Z";
  const T2 = "2026-10-01T12:00:02.000Z";
  const T3 = "2026-10-01T12:00:03.000Z";

  it("reads every member's solve rows in one pipeline and gives counts and the first solver per challenge", async () => {
    m.listTeams.mockResolvedValue([
      { slug: "red", name: "Red", members: ["Alice", "bob"] },
      { slug: "blue", name: "Blue", members: ["carol"] },
    ]);
    m.upstashPipeline.mockResolvedValue([
      { result: solves(["recon", T2], ["web", T3]) },
      { result: solves(["recon", T3]) },
      { result: solves(["recon", T1]) },
    ]);
    const board = await teamSolveBoard("classic");
    expect(m.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(m.upstashPipeline.mock.calls[0][0]).toEqual([
      ["HGETALL", "ctf:classic:solves:Alice"],
      ["HGETALL", "ctf:classic:solves:bob"],
      ["HGETALL", "ctf:classic:solves:carol"],
    ]);
    expect(board?.counts).toEqual(new Map([["recon", 2], ["web", 1]]));
    // The display login: the spelling the member set holds, not lowercased.
    expect(board?.firstBlood).toEqual(
      new Map([
        ["recon", { login: "carol", at: T1 }],
        ["web", { login: "Alice", at: T3 }],
      ]),
    );
  });

  it("breaks a same-instant tie by login, whichever team is listed first", async () => {
    const teams = [
      { slug: "red", name: "Red", members: ["zed"] },
      { slug: "blue", name: "Blue", members: ["amy"] },
    ];
    for (const order of [teams, [...teams].reverse()]) {
      m.listTeams.mockResolvedValue(order);
      m.upstashPipeline.mockResolvedValue(order.map(() => ({ result: solves(["recon", T1]) })));
      expect((await teamSolveBoard("classic"))?.firstBlood.get("recon")?.login).toBe("amy");
    }
  });

  it("counts a solve row it cannot read a time from, and ranks it after every timed one", async () => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["amy", "zed"] }]);
    m.upstashPipeline.mockResolvedValue([{ result: ["recon", "not json"] }, { result: solves(["recon", T3]) }]);
    const board = await teamSolveBoard("classic");
    expect(board?.counts.get("recon")).toBe(1);
    expect(board?.firstBlood.get("recon")).toEqual({ login: "zed", at: T3 });
  });

  // The acceptance pin: the Support tab's reset and delete both clear the
  // contestant's solves hash (RESET_MODULE_SOLVES_SCRIPT DELs it), and delete
  // and remove-from-team both take them off the member set. Either way their
  // first bloods pass to the next solver, with nothing to clean up.
  it("passes a removed contestant's first blood to the next solver", async () => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice", "bob"] }]);
    m.upstashPipeline.mockResolvedValue([{ result: solves(["recon", T1]) }, { result: solves(["recon", T2]) }]);
    expect((await teamSolveBoard("classic"))?.firstBlood.get("recon")?.login).toBe("alice");

    // Progress reset: alice is still a member, her solves hash is gone.
    m.upstashPipeline.mockResolvedValue([{ result: [] }, { result: solves(["recon", T2]) }]);
    expect((await teamSolveBoard("classic"))?.firstBlood.get("recon")).toEqual({ login: "bob", at: T2 });

    // Deleted (or removed from the team): no longer a member at all.
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["bob"] }]);
    m.upstashPipeline.mockResolvedValue([{ result: solves(["recon", T2]) }]);
    expect((await teamSolveBoard("classic"))?.firstBlood.get("recon")).toEqual({ login: "bob", at: T2 });

    // The only solver gone: no first blood at all, not a stale one.
    m.upstashPipeline.mockResolvedValue([{ result: [] }]);
    expect((await teamSolveBoard("classic"))?.firstBlood.has("recon")).toBe(false);
  });

  it("is empty with no teams, without reading any solves", async () => {
    m.listTeams.mockResolvedValue([]);
    expect(await teamSolveBoard("classic")).toEqual({ counts: new Map(), firstBlood: new Map() });
    expect(m.upstashPipeline).not.toHaveBeenCalled();
  });

  // A first blood read off a short read could name the wrong contestant, as
  // a short count reads as a real one: the whole board is null instead.
  it.each([
    ["a missing reply", [{ result: solves(["recon", T1]) }]],
    ["a non-list result", [{ result: solves(["recon", T1]) }, { result: "recon" }]],
    ["an errored reply", [{ result: solves(["recon", T1]) }, { error: "NOAUTH" }]],
  ])("is null for %s, never a short board", async (_what, replies) => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice", "bob"] }]);
    m.upstashPipeline.mockResolvedValue(replies);
    expect(await teamSolveBoard("classic")).toBeNull();
  });

  it("is null when the team list cannot be read", async () => {
    m.listTeams.mockRejectedValue(new Error("SCAN failed"));
    expect(await teamSolveBoard("classic")).toBeNull();
  });
});
