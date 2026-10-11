// Stories (#463) unlock per TEAM. Since #602 a teammate's solve opens the next
// step only if they were on the team when they made it (solve `at` on or
// after their `joinedAt`), so a player cannot carry a solved step from one
// team to another and unlock the next step there. Points are unaffected.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ upstashPipeline: vi.fn(), getViewerTeam: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: m.upstashPipeline }));
vi.mock("@/lib/team-store", () => ({ getViewerTeam: m.getViewerTeam }));

import { getTeamClassicSolvedIds, teamLockKeys, unlockingSolvedIds } from "@/lib/classic-team";

beforeEach(() => vi.clearAllMocks());

const solve = (at: string) => JSON.stringify({ points: 10, at });
/** One login's two replies: HGETALL of its solves, HMGET team/joinedAt. */
const member = (solves: Record<string, string>, team: string | null, joinedAt: string | null) => [
  { result: Object.entries(solves).flat() },
  { result: [team, joinedAt] },
];

describe("teamLockKeys", () => {
  // Exact-string dedupe (review I3): a member stored in a different case than
  // the viewer's session keeps BOTH spellings — dropping one could drop the
  // very hash that holds the solves.
  it("pairs every member's solves key with their user record, viewer first, and names the team", async () => {
    m.getViewerTeam.mockResolvedValue({ slug: "t", name: "T", members: ["Alice", "bob", "alice"] });
    expect(await teamLockKeys("alice")).toEqual({
      team: "t",
      keys: [
        "ctf:classic:solves:alice",
        "ctf:user:alice",
        "ctf:classic:solves:Alice",
        "ctf:user:Alice",
        "ctf:classic:solves:bob",
        "ctf:user:bob",
      ],
    });
  });

  it("is just the viewer's own pair with no team (a team of one)", async () => {
    m.getViewerTeam.mockResolvedValue(null);
    expect(await teamLockKeys("carol")).toEqual({ team: "", keys: ["ctf:classic:solves:carol", "ctf:user:carol"] });
  });
});

describe("unlockingSolvedIds", () => {
  it("counts a member's solves made since they joined this team", async () => {
    m.upstashPipeline.mockResolvedValue([
      ...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "t", "2026-10-07T11:00:00.000Z"),
      ...member({ web: solve("2026-10-07T13:00:00.000Z") }, "t", "2026-10-07T11:30:00.000Z"),
    ]);
    expect(await unlockingSolvedIds(["alice", "bob"], "t")).toEqual(new Set(["recon", "web"]));
  });

  // The carry: X solved step 3 on team A, left, joined B. Their step 3 is
  // older than their B joinedAt, so it opens nothing for B.
  it("does not count a solve made before the member joined", async () => {
    m.upstashPipeline.mockResolvedValue([
      ...member({ "step-3": solve("2026-10-07T12:00:00.000Z") }, "b", "2026-10-07T12:30:00.000Z"),
    ]);
    expect(await unlockingSolvedIds(["x"], "b")).toEqual(new Set());
  });

  it("counts a solve made the same instant the member joined", async () => {
    m.upstashPipeline.mockResolvedValue([...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "t", "2026-10-07T12:00:00.000Z")]);
    expect(await unlockingSolvedIds(["alice"], "t")).toEqual(new Set(["recon"]));
  });

  it("does not count a member whose record names another team (left since the roster was read)", async () => {
    m.upstashPipeline.mockResolvedValue([...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "other", "2026-10-07T11:00:00.000Z")]);
    expect(await unlockingSolvedIds(["alice"], "t")).toEqual(new Set());
  });

  it("does not count a member on a team with no join time (closed: fewer unlocks, never more)", async () => {
    m.upstashPipeline.mockResolvedValue([...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "t", null)]);
    expect(await unlockingSolvedIds(["alice"], "t")).toEqual(new Set());
  });

  it("counts every own solve for a player on no team (a team of one)", async () => {
    m.upstashPipeline.mockResolvedValue([...member({ recon: solve("2026-10-07T12:00:00.000Z") }, null, null)]);
    expect(await unlockingSolvedIds(["carol"], null)).toEqual(new Set(["recon"]));
  });

  it("does not count a team-of-one viewer's solves once their record says they joined a team", async () => {
    m.upstashPipeline.mockResolvedValue([...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "t", "2026-10-07T13:00:00.000Z")]);
    expect(await unlockingSolvedIds(["carol"], null)).toEqual(new Set());
  });

  // A board row's roster, with no viewer team to compare against: each
  // member's solves count for the team they are on now, from when they joined.
  it("applies the rule per member for a roster with no team named", async () => {
    m.upstashPipeline.mockResolvedValue([
      ...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "b", "2026-10-07T12:30:00.000Z"),
      ...member({ web: solve("2026-10-07T13:00:00.000Z") }, "b", "2026-10-07T11:00:00.000Z"),
    ]);
    expect(await unlockingSolvedIds(["x", "y"])).toEqual(new Set(["web"]));
  });

  it("THROWS on a read error — the caller fails closed, never 'nothing solved' silently", async () => {
    m.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }, { result: [null, null] }]);
    await expect(unlockingSolvedIds(["alice"], null)).rejects.toThrow();
  });
});

describe("getTeamClassicSolvedIds", () => {
  it("reads the viewer and every teammate under the viewer's team", async () => {
    m.getViewerTeam.mockResolvedValue({ slug: "t", name: "T", members: ["alice", "bob"] });
    m.upstashPipeline.mockResolvedValue([
      ...member({ recon: solve("2026-10-07T12:00:00.000Z") }, "t", "2026-10-07T11:00:00.000Z"),
      ...member({ web: solve("2026-10-07T10:00:00.000Z") }, "t", "2026-10-07T11:00:00.000Z"),
    ]);
    expect(await getTeamClassicSolvedIds("alice")).toEqual(new Set(["recon"]));
    expect(m.upstashPipeline.mock.calls[0][0]).toEqual([
      ["HGETALL", "ctf:classic:solves:alice"],
      ["HMGET", "ctf:user:alice", "team", "joinedAt"],
      ["HGETALL", "ctf:classic:solves:bob"],
      ["HMGET", "ctf:user:bob", "team", "joinedAt"],
    ]);
  });
});
