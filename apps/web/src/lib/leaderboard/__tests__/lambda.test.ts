// Unit tests for the lambda source adapter: maps the deployed Lambda's real
// response shape (including the lastSolveAt tie-breaker) into the normalized
// LeaderboardEntry, and re-ranks instead of trusting the Lambda's rank field.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { lambdaSource } from "../lambda";

// Trimmed copy of the live response shape (two apps is enough).
const RESPONSE = {
  leaderboard: [
    {
      rank: 1,
      author: "dcotelo",
      points: 672,
      lastSolveAt: "2026-07-08T19:25:23.830Z",
      apps: {
        "juice-shop": { solved: 38, total: 38 },
        dvwa: { solved: 55, total: 55 },
      },
    },
    // Tied on points; the Lambda ordered the LATER solver first — the adapter
    // must flip them (earlier last solve wins the tie).
    {
      rank: 2,
      author: "later-solver",
      points: 145,
      lastSolveAt: "2026-07-14T20:16:12.661Z",
      apps: { "juice-shop": { solved: 38, total: 38 } },
    },
    {
      rank: 3,
      author: "earlier-solver",
      points: 145,
      lastSolveAt: "2026-07-14T19:42:27.026Z",
      apps: { "juice-shop": { solved: 38, total: 38 } },
    },
  ],
};

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("lambdaSource.getLeaderboard", () => {
  it("captures lastSolveAt and uses it as the source's updatedAt", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(RESPONSE);
    const data = await lambdaSource.getLeaderboard();
    const top = data.entries[0];
    expect(top.login).toBe("dcotelo");
    expect(top.lastSolveAt).toBe("2026-07-08T19:25:23.830Z");
    // Solves are the only updates in this source, so last solve = last update.
    expect(top.updatedAt).toBe("2026-07-08T19:25:23.830Z");
  });

  it("re-ranks point ties by earlier lastSolveAt instead of trusting the Lambda's rank", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(RESPONSE);
    const data = await lambdaSource.getLeaderboard();
    expect(data.entries.map((e) => [e.login, e.rank])).toEqual([
      ["dcotelo", 1],
      ["earlier-solver", 2],
      ["later-solver", 3],
    ]);
  });

  it("tolerates entries without lastSolveAt (older Lambda payloads)", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({
      leaderboard: [{ rank: 1, author: "old", points: 10, apps: { dvwa: { solved: 1, total: 55 } } }],
    });
    const data = await lambdaSource.getLeaderboard();
    expect(data.entries[0]).toMatchObject({ login: "old", lastSolveAt: null, updatedAt: null, rank: 1 });
  });
});

describe("lambdaSource.getLeaderboard series", () => {
  it("maps the Lambda's series field through onto LeaderboardData.series", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({
      ...RESPONSE,
      series: [
        {
          login: "dcotelo",
          points: [
            { t: "2026-07-08T10:00:00.000Z", score: 100 },
            { t: "2026-07-08T19:25:23.830Z", score: 672 },
          ],
        },
      ],
    });
    const data = await lambdaSource.getLeaderboard();
    expect(data.series).toEqual([
      {
        login: "dcotelo",
        points: [
          { t: "2026-07-08T10:00:00.000Z", score: 100 },
          { t: "2026-07-08T19:25:23.830Z", score: 672 },
        ],
      },
    ]);
  });

  it("tolerates an older scorer that sends no series field at all", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(RESPONSE); // no `series` key
    const data = await lambdaSource.getLeaderboard();
    expect(data.series).toBeUndefined();
  });

  it("tolerates an empty series array (declarative-only deployment)", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({ ...RESPONSE, series: [] });
    const data = await lambdaSource.getLeaderboard();
    expect(data.series).toBeUndefined();
  });

  it("drops malformed players/points instead of throwing", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({
      ...RESPONSE,
      series: [
        { login: "ok", points: [{ t: "2026-07-08T10:00:00.000Z", score: 5 }, { t: 123, score: "nope" }] },
        { login: 42, points: [{ t: "2026-07-08T10:00:00.000Z", score: 5 }] },
        { login: "empty-after-filter", points: [{ t: 1, score: 2 }] },
        "not an object",
      ],
    });
    const data = await lambdaSource.getLeaderboard();
    expect(data.series).toEqual([{ login: "ok", points: [{ t: "2026-07-08T10:00:00.000Z", score: 5 }] }]);
  });
});

describe("lambdaSource.getLeaderboard teams", () => {
  it("maps the Lambda's teams + teamSeries fields and flips on the teams capability", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({
      ...RESPONSE,
      teams: [
        {
          rank: 1,
          slug: "red-team",
          name: "Red Team",
          captain: "dcotelo",
          members: ["dcotelo", "later-solver"],
          points: 817,
          lastSolveAt: "2026-07-14T20:16:12.661Z",
          apps: { "juice-shop": { solved: 38, total: 38 } },
        },
      ],
      teamSeries: [
        {
          slug: "red-team",
          name: "Red Team",
          points: [
            { t: "2026-07-08T10:00:00.000Z", score: 100 },
            { t: "2026-07-14T20:16:12.661Z", score: 817 },
          ],
        },
      ],
    });
    const data = await lambdaSource.getLeaderboard();
    expect(data.teams).toEqual([
      { rank: 1, slug: "red-team", name: "Red Team", captain: "dcotelo", members: ["dcotelo", "later-solver"], points: 817 },
    ]);
    expect(data.teamSeries).toEqual([
      {
        slug: "red-team",
        name: "Red Team",
        points: [
          { t: "2026-07-08T10:00:00.000Z", score: 100 },
          { t: "2026-07-14T20:16:12.661Z", score: 817 },
        ],
      },
    ]);
    expect(data.capabilities.teams).toBe(true);
  });

  it("tolerates a scorer with no teams field at all", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(RESPONSE); // no `teams`/`teamSeries` keys
    const data = await lambdaSource.getLeaderboard();
    expect(data.teams).toEqual([]);
    expect(data.teamSeries).toBeUndefined();
    expect(data.capabilities.teams).toBe(false);
  });

  it("tolerates an empty teams array", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({ ...RESPONSE, teams: [] });
    const data = await lambdaSource.getLeaderboard();
    expect(data.teams).toEqual([]);
    expect(data.capabilities.teams).toBe(false);
  });

  it("drops malformed team entries instead of throwing", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({
      ...RESPONSE,
      teams: [
        { rank: 1, slug: "ok-team", name: "Ok Team", captain: "dcotelo", members: ["dcotelo", 42], points: 100 },
        { rank: 2, slug: "missing-captain", name: "No Captain", members: ["x"], points: 50 },
        { rank: "3", slug: "bad-rank", name: "Bad Rank", captain: "x", members: [], points: 10 },
        { slug: "no-members", name: "No Members", captain: "x", points: 5, members: "nope" },
        "not an object",
        null,
      ],
    });
    const data = await lambdaSource.getLeaderboard();
    // Malformed entries dropped; the string member "42" is filtered out but
    // the valid entry still gets in with a non-empty members array.
    expect(data.teams).toEqual([
      { rank: 1, slug: "ok-team", name: "Ok Team", captain: "dcotelo", members: ["dcotelo"], points: 100 },
    ]);
    expect(data.capabilities.teams).toBe(true);
  });
});

describe("lambdaSource.getLeaderboard catalog (per-challenge)", () => {
  // A response carrying the newer `catalog` + `solvedIds` fields.
  const WITH_CATALOG = {
    leaderboard: [
      {
        rank: 1,
        author: "neo",
        points: 15,
        lastSolveAt: "2026-08-14T11:00:00.000Z",
        apps: { "juice-shop": { solved: 1, total: 2, solvedIds: ["xss"] } },
      },
    ],
    teams: [
      {
        rank: 1,
        slug: "zero-cool",
        name: "Zero Cool",
        captain: "neo",
        members: ["neo", "trin"],
        points: 15,
        apps: { "juice-shop": { solved: 2, total: 2, solvedIds: ["xss", "sqli"] } },
      },
    ],
    catalog: {
      "juice-shop": [
        { id: "xss", name: "Reflected XSS", points: 10, owasp: "A03" },
        { id: "sqli", name: "SQL injection", points: 5, owasp: null },
      ],
    },
  };

  it("hoists the catalogue once and leaves each row its solvedIds; flips the challenges capability", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(WITH_CATALOG);
    const data = await lambdaSource.getLeaderboard();
    expect(data.capabilities.challenges).toBe(true);
    // The catalogue travels ONCE, on the data, in the public shape the
    // renderer joins against (issue #434).
    expect(data.catalog).toEqual({
      "juice-shop": [
        { key: "xss", name: "Reflected XSS", points: 10, owasp: "A03" },
        { key: "sqli", name: "SQL injection", points: 5, owasp: null },
      ],
    });
    const app = data.entries[0].apps["juice-shop"]!;
    // A row carries only what varies per row: which ids it solved.
    expect(app.solvedIds).toEqual(["xss"]);
    expect(app).not.toHaveProperty("challenges");
    // Points/max are still derived server-side from the catalogue.
    expect(app.points).toBe(10);
    expect(app.maxPoints).toBe(15);
    // The team row is the same shape — a union of solved ids, no expansion.
    expect(data.teams[0].apps!["juice-shop"]!.solvedIds).toEqual(["xss", "sqli"]);
  });

  // The measurement behind #434/#439: at 200 contestants + 68 teams the page
  // was 13 MB because every row carried a private copy of the 321-challenge
  // catalogue. The property that prevents it coming back is that a challenge's
  // NAME is serialized exactly once no matter how many rows solved it.
  it("serializes each challenge name once regardless of how many rows exist", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    const many = {
      ...WITH_CATALOG,
      leaderboard: Array.from({ length: 25 }, (_, i) => ({
        rank: i + 1,
        author: `p${i}`,
        points: 15,
        lastSolveAt: "2026-08-14T11:00:00.000Z",
        apps: { "juice-shop": { solved: 2, total: 2, solvedIds: ["xss", "sqli"] } },
      })),
      teams: Array.from({ length: 8 }, (_, i) => ({
        rank: i + 1,
        slug: `t${i}`,
        name: `Team ${i}`,
        captain: `p${i}`,
        members: [`p${i}`, `p${i + 1}`],
        points: 15,
        apps: { "juice-shop": { solved: 2, total: 2, solvedIds: ["xss", "sqli"] } },
      })),
    };
    stubFetch(many);
    const json = JSON.stringify(await lambdaSource.getLeaderboard());
    expect(json.split("Reflected XSS").length - 1).toBe(1);
    expect(json.split("SQL injection").length - 1).toBe(1);
    // …while every row still says what it solved.
    expect(json.split('"solvedIds":["xss","sqli"]').length - 1).toBe(25 + 8);
  });

  it("aggregates a profile's maxPoints as the sum of its targets', not a hardcoded 0", async () => {
    // The bug this replaces: getUser returned maxPoints 0 while toAppProgress
    // computed a real per-target maxPoints from the same catalogue, so
    // /profile's module header read "N / 0 pts" above target rows that summed
    // to a real ceiling. Same aggregation mockSource has always done.
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(WITH_CATALOG);
    const profile = await lambdaSource.getUser("neo");
    expect(profile).toMatchObject({ login: "neo", points: 15, maxPoints: 15 });
    expect(profile!.apps.reduce((n, a) => n + a.maxPoints, 0)).toBe(profile!.maxPoints);
    // /profile renders the same breakdown as the board, so it needs the same
    // catalogue to join solvedIds against.
    expect(profile!.catalog).toEqual((await lambdaSource.getLeaderboard()).catalog);
  });

  it("still reports 0 when no catalogue means no target carries points at all", async () => {
    // Not a regression: with maxPoints 0 everywhere there is genuinely no
    // ceiling to show, and the row hides the points pair rather than
    // inventing one.
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(RESPONSE); // no catalog field
    const profile = await lambdaSource.getUser("dcotelo");
    expect(profile?.maxPoints).toBe(0);
  });

  it("builds the team's union of solved flags from its apps.solvedIds", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(WITH_CATALOG);
    const data = await lambdaSource.getLeaderboard();
    const teamApp = data.teams[0].apps?.["juice-shop"];
    expect(teamApp?.solvedIds).toEqual(["xss", "sqli"]);
    expect(teamApp?.points).toBe(15);
  });

  it("leaves the challenges capability off and attaches no challenges when there is no catalog", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch(RESPONSE); // no catalog field
    const data = await lambdaSource.getLeaderboard();
    expect(data.capabilities.challenges).toBe(false);
    expect(data.entries[0].apps["juice-shop"]?.solvedIds).toBeUndefined();
    expect(data.catalog).toBeUndefined();
    expect(data.teams[0]?.apps).toBeUndefined();
  });

  it("tolerates a malformed catalog rather than throwing", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://scorer.example");
    stubFetch({
      ...WITH_CATALOG,
      catalog: {
        "juice-shop": [
          { id: "ok", name: "Fine", points: 3, owasp: null },
          { id: 42, name: "bad id", points: 1 }, // dropped
          { name: "no id", points: 1 }, // dropped
          "nope", // dropped
        ],
        "bad-app": "not an array", // ignored
      },
    });
    const data = await lambdaSource.getLeaderboard();
    expect(data.capabilities.challenges).toBe(true);
    expect(data.catalog?.["juice-shop"]?.map((c) => c.key)).toEqual(["ok"]);
    // The entry solved "xss", which this catalogue does not know — the id is
    // dropped rather than carried into a row nothing can name.
    expect(data.entries[0].apps["juice-shop"]?.solvedIds).toEqual([]);
  });
});
