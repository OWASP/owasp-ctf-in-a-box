// Stories (#463) unlock per TEAM: the solves that count are the union of
// every current teammate's classic solves.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ upstashPipeline: vi.fn(), getViewerTeam: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: m.upstashPipeline }));
vi.mock("@/lib/team-store", () => ({ getViewerTeam: m.getViewerTeam }));

import { getTeamClassicSolvedIds, teamSolveKeys } from "@/lib/classic-team";

beforeEach(() => vi.clearAllMocks());

describe("teamSolveKeys", () => {
  // Exact-string dedupe (review I3): a member stored in a different case than
  // the viewer's session keeps BOTH spellings — dropping one could drop the
  // very hash that holds the solves. An extra HEXISTS key costs nothing.
  it("is every teammate's solves key plus the viewer's own, keeping a differently-cased member spelling", async () => {
    m.getViewerTeam.mockResolvedValue({ slug: "t", name: "T", members: ["Alice", "bob", "alice"] });
    expect(await teamSolveKeys("alice")).toEqual([
      "ctf:classic:solves:alice",
      "ctf:classic:solves:Alice",
      "ctf:classic:solves:bob",
    ]);
  });

  it("is just the viewer's own key with no team (a team of one)", async () => {
    m.getViewerTeam.mockResolvedValue(null);
    expect(await teamSolveKeys("carol")).toEqual(["ctf:classic:solves:carol"]);
  });
});

describe("getTeamClassicSolvedIds", () => {
  it("unions every member's solved challenge ids", async () => {
    m.getViewerTeam.mockResolvedValue({ slug: "t", name: "T", members: ["alice", "bob"] });
    m.upstashPipeline.mockResolvedValue([{ result: ["recon"] }, { result: ["web", "recon"] }]);
    expect(await getTeamClassicSolvedIds("alice")).toEqual(new Set(["recon", "web"]));
  });

  it("THROWS on a read error — the caller fails closed, never 'nothing solved' silently", async () => {
    m.getViewerTeam.mockResolvedValue(null);
    m.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(getTeamClassicSolvedIds("alice")).rejects.toThrow();
  });
});
