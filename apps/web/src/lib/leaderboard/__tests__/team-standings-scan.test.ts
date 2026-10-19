import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstashResult } from "@/lib/upstash";
import type { LeaderboardData } from "../types";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<UpstashResult[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
// Only the transport is replaced: SCAN validation, team discovery, quiz folds
// and both leaderboard overlays execute their production implementations.
vi.mock("@/lib/upstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upstash")>()),
  upstashPipeline: mocks.upstashPipeline,
}));

const alpha = "ctf:team:alpha:members";
const beta = "ctf:team:beta:members";
const at = "2026-08-01T00:00:00.000Z";
const answer = (points: number) => JSON.stringify({ points, at });

const replies = new Map<string, unknown>([
  [JSON.stringify(["HGET", "ctf:team:alpha", "name"]), "Alpha"],
  [JSON.stringify(["SMEMBERS", alpha]), ["bob", "Alice"]],
  [JSON.stringify(["HGET", "ctf:team:beta", "name"]), "Beta"],
  [JSON.stringify(["SMEMBERS", beta]), ["cara"]],
  [JSON.stringify(["HGETALL", "ctf:quiz:points"]), ["alice", "11", "bob", "18", "cara", "7", "solo", "4"]],
  [JSON.stringify(["HGETALL", "ctf:quiz:answered"]), ["alice", "1", "bob", "2", "cara", "1", "solo", "1"]],
  [JSON.stringify(["HGETALL", "ctf:quiz:lastAt"]), []],
  [JSON.stringify(["HGETALL", "ctf:quiz:questions"]), []],
  [JSON.stringify(["HGETALL", "ctf:quiz:answers:Alice"]), ["shared", answer(11)]],
  [JSON.stringify(["HGETALL", "ctf:quiz:answers:bob"]), ["shared", answer(11), "extra", answer(7)]],
  [JSON.stringify(["HGETALL", "ctf:quiz:answers:cara"]), ["other", answer(7)]],
]);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("TEAM_WRITES_ENABLED", "true");
});

afterEach(() => vi.unstubAllEnvs());

describe("team discovery through the leaderboard pipeline", () => {
  it.each([
    { scenario: "distinct keys across pages", first: [alpha], second: [beta] },
    { scenario: "a repeated key across pages", first: [alpha], second: [alpha, beta] },
    { scenario: "a repeated key within a page", first: [alpha, alpha], second: [beta] },
  ])("keeps one team and its original points/rank with $scenario", async ({ first, second }) => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map((command) => {
      if (command[0] === "SCAN") {
        expect(command).toEqual(["SCAN", command[1], "MATCH", "ctf:team:*:members", "COUNT", "1000"]);
        if (command[1] === "0") return { result: ["7", first] };
        if (command[1] === "7") return { result: ["0", second] };
      }
      const key = JSON.stringify(command);
      if (!replies.has(key)) throw new Error(`Unexpected Redis command: ${key}`);
      return { result: replies.get(key) };
    }));
    const { listTeams } = await import("@/lib/team-store");
    const { withModuleContributions } = await import("../module-contributions");
    const { withTeamStandings } = await import("../team-standings");

    const teams = await listTeams();
    expect.soft(teams).toEqual([
      { slug: "alpha", name: "Alpha", members: ["Alice", "bob"] },
      { slug: "beta", name: "Beta", members: ["cara"] },
    ]);
    expect.soft(mocks.upstashPipeline.mock.calls.at(-1)?.[0]).toEqual([
      ["HGET", "ctf:team:alpha", "name"],
      ["SMEMBERS", alpha],
      ["HGET", "ctf:team:beta", "name"],
      ["SMEMBERS", beta],
    ]);
    expect(mocks.upstashPipeline.mock.calls.slice(0, 2).map(([commands]) => commands[0][1])).toEqual(["0", "7"]);

    const source: LeaderboardData = {
      entries: [],
      teams: [],
      generatedAt: at,
      capabilities: { apps: false, teams: false, challenges: false },
    };
    const result = await withTeamStandings(await withModuleContributions(source));

    expect.soft(result.teams.map(({ slug, points, rank, members }) => ({ slug, points, rank, members }))).toEqual([
      { slug: "alpha", points: 18, rank: 1, members: ["Alice", "bob"] },
      { slug: "beta", points: 7, rank: 2, members: ["cara"] },
    ]);
    // Both Alpha members hold "shared": its 11 points count once for the
    // team while each player's original total and case-insensitive team stay.
    expect(result.entries.map(({ login, points, rank, team }) => ({ login, points, rank, team }))).toEqual([
      { login: "bob", points: 18, rank: 1, team: "alpha" },
      { login: "alice", points: 11, rank: 2, team: "alpha" },
      { login: "cara", points: 7, rank: 3, team: "beta" },
      { login: "solo", points: 4, rank: 4, team: null },
    ]);
  });
});
