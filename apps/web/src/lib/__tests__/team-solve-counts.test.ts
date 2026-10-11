// #595: the board counts TEAMS that solved a challenge, not players. Scoring
// is per team, so two members solving one flag count once; a teamless solver
// is not counted. Derived from current members' solves at read time, never
// stored, so a team change cannot leave it stale.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ upstashPipeline: vi.fn(), listTeams: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: m.upstashPipeline }));
vi.mock("@/lib/team-store", () => ({ listTeams: m.listTeams }));

import { teamSolveCounts } from "@/lib/team-solve-counts";

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
  it("is null when a read fails, never a short count", async () => {
    m.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["alice", "bob"] }]);
    m.upstashPipeline.mockResolvedValue([{ result: ["recon"] }, { error: "NOAUTH" }]);
    expect(await teamSolveCounts("classic")).toBeNull();
    m.listTeams.mockRejectedValue(new Error("SCAN failed"));
    expect(await teamSolveCounts("classic")).toBeNull();
  });
});
