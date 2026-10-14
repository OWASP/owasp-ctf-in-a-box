// The leaderboard source for an event with NO scored module.
//
// With `secure-development` disabled there is no scorer, no lambda and no
// Upstash scoring data for this event, so every configured source is wrong:
// mock would serve placeholder standings as if they were real, and
// lambda would read a backend that was never deployed. The board is
// built entirely by the module overlays instead, on top of an empty source.
//
// `vi.mock` is hoisted per file, so this fixture lives in its own file — see
// modules-resolve.test.ts, and source.test.ts for the
// secure-development-enabled half of this behaviour.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The real source modules reach for network clients at import time; none of
// them should be selected here, which is most of the point.
vi.mock("@/lib/leaderboard/mock", () => ({ mockSource: { id: "mock" } }));
vi.mock("@/lib/leaderboard/lambda", () => ({ lambdaSource: { id: "lambda" } }));
// This event is quiz-only: secure-development is not live, which is the
// whole premise of this suite.
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: async () => false }));

import { getLeaderboardSource, getLeaderboardSourceMode } from "@/lib/leaderboard/source";

const original = process.env.LEADERBOARD_SOURCE;

afterEach(() => {
  if (original === undefined) delete process.env.LEADERBOARD_SOURCE;
  else process.env.LEADERBOARD_SOURCE = original;
});

describe("with secure-development disabled", () => {
  it("returns an empty source", async () => {
    const data = await (await getLeaderboardSource()).getLeaderboard();
    expect(data.entries).toEqual([]);
    expect(data.teams).toEqual([]);
    expect(data.capabilities).toEqual({ apps: false, teams: false, challenges: false });
  });

  it("stamps a parseable generatedAt, so relative times still format", async () => {
    const data = await (await getLeaderboardSource()).getLeaderboard();
    expect(Number.isFinite(Date.parse(data.generatedAt))).toBe(true);
  });

  it("has no profile to serve", async () => {
    expect(await (await getLeaderboardSource()).getUser("ada")).toBeNull();
  });

  it.each(["mock", "lambda", "upstash", undefined])(
    "ignores LEADERBOARD_SOURCE=%s — a backend this event never deployed is not a setting to honour",
    async (value) => {
      if (value === undefined) delete process.env.LEADERBOARD_SOURCE;
      else process.env.LEADERBOARD_SOURCE = value;
      const data = await (await getLeaderboardSource()).getLeaderboard();
      expect(data.entries).toEqual([]);
    },
  );

  // /leaderboard renders the amber "these are placeholder standings" banner
  // whenever the mode is "mock" — which is the default when LEADERBOARD_SOURCE
  // is unset. On a quiz-only event the board carries REAL quiz points, so
  // reporting "mock" here would put a false disclaimer over true scores.
  it("does not report the mock mode, whatever LEADERBOARD_SOURCE says", async () => {
    delete process.env.LEADERBOARD_SOURCE;
    expect(await getLeaderboardSourceMode()).toBe("empty");
    process.env.LEADERBOARD_SOURCE = "mock";
    expect(await getLeaderboardSourceMode()).toBe("empty");
  });

  // Deliberately NOT the mock source: mock data on a real event is worse than
  // an empty board, because contestants cannot tell it from their own scores.
  it("never falls back to the mock fixture", async () => {
    expect(((await getLeaderboardSource()) as unknown as { id?: string }).id).toBeUndefined();
  });
});
