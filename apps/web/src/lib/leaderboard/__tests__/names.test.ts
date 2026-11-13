import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getPlayerProfiles } = vi.hoisted(() => ({ getPlayerProfiles: vi.fn() }));
vi.mock("@/lib/player", async () => {
  const shared = await import("@/lib/display-name");
  return { getPlayerProfiles, displayNameOf: shared.displayNameOf };
});

import { attachNames, withPlayerNames } from "@/lib/leaderboard/names";
import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard/types";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ADA = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const GONE = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

function profiles(entries: [string, string, string | null][]) {
  return new Map(entries.map(([pid, name, image]) => [pid, { id: pid, name, image, githubLogin: null }]));
}

beforeEach(() => {
  getPlayerProfiles.mockReset();
});

describe("attachNames", () => {
  it("resolves 300 distinct players in one profile read", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ playerId: id(i) }));
    getPlayerProfiles.mockResolvedValue(profiles(rows.map((r, i) => [r.playerId, `p${i}`, null])));

    const named = await attachNames(rows);

    expect(getPlayerProfiles).toHaveBeenCalledTimes(1);
    expect(getPlayerProfiles.mock.calls[0][0]).toHaveLength(300);
    expect(named[299]).toEqual({ playerId: id(299), name: "p299", image: null });
  });

  it("names a player with no profile from the id and gives no image", async () => {
    getPlayerProfiles.mockResolvedValue(profiles([[ADA, "ada", "https://img.example/ada.png"]]));

    const named = await attachNames([{ playerId: ADA }, { playerId: GONE }]);

    expect(named).toEqual([
      { playerId: ADA, name: "ada", image: "https://img.example/ada.png" },
      { playerId: GONE, name: "player 9f8e7d6c", image: null },
    ]);
  });

  it("looks each repeated id up once", async () => {
    getPlayerProfiles.mockResolvedValue(profiles([[ADA, "ada", null]]));

    const named = await attachNames([{ playerId: ADA, n: 1 }, { playerId: GONE, n: 2 }, { playerId: ADA, n: 3 }]);

    expect(getPlayerProfiles).toHaveBeenCalledTimes(1);
    expect(getPlayerProfiles.mock.calls[0][0]).toEqual([ADA, GONE]);
    expect(named.map((r) => [r.n, r.name])).toEqual([[1, "ada"], [2, "player 9f8e7d6c"], [3, "ada"]]);
  });

  it("makes no read for no rows", async () => {
    expect(await attachNames([])).toEqual([]);
    expect(getPlayerProfiles).not.toHaveBeenCalled();
  });

  it("keeps a name the row already carries when the player has no profile", async () => {
    getPlayerProfiles.mockResolvedValue(new Map());

    const [row] = await attachNames([{ playerId: "octocat", name: "octocat", image: null }]);

    expect(row.name).toBe("octocat");
  });

  it("falls back to the id names when the profile read fails, and logs it", async () => {
    getPlayerProfiles.mockRejectedValue(new Error("player profiles: HMGET failed: NOAUTH"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const named = await attachNames([{ playerId: ADA }]);

    expect(named).toEqual([{ playerId: ADA, name: "player 1a2b3c4d", image: null }]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("player names unavailable"), expect.anything());
    error.mockRestore();
  });
});

function entry(playerId: string, points: number): LeaderboardEntry {
  return {
    rank: 0,
    playerId,
    name: `player ${playerId.slice(0, 8)}`,
    image: null,
    team: null,
    points,
    patched: 0,
    failed: 0,
    total: 0,
    apps: {},
    updatedAt: null,
  };
}

describe("withPlayerNames", () => {
  it("names every entry and series line in one read", async () => {
    getPlayerProfiles.mockResolvedValue(profiles([[ADA, "ada", "https://img.example/ada.png"]]));
    const data: LeaderboardData = {
      entries: [entry(ADA, 5), entry(GONE, 1)],
      teams: [],
      generatedAt: "2026-11-12T00:00:00Z",
      capabilities: { apps: false, teams: false, challenges: false },
      series: [{ playerId: ADA, name: "x", image: null, points: [{ t: "2026-11-12T00:00:00Z", score: 5 }] }],
    };

    const out = await withPlayerNames(data);

    expect(getPlayerProfiles).toHaveBeenCalledTimes(1);
    expect(getPlayerProfiles.mock.calls[0][0]).toEqual([ADA, GONE]);
    expect(out.entries.map((e) => [e.name, e.image])).toEqual([
      ["ada", "https://img.example/ada.png"],
      ["player 9f8e7d6c", null],
    ]);
    expect(out.series?.[0].name).toBe("ada");
  });
});
