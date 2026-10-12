import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadRubric } from "../src/rubric.js";
import { createMemoryStore } from "../src/store.js";
import { createHandler, startServer, buildLeaderboard } from "../src/serve.js";

const RUBRIC = loadRubric(fileURLToPath(new URL("./fixtures/rubric-valid/", import.meta.url)));
const TOKEN = "s3cret";
const T = [
  "2026-08-14T10:00:00.000Z",
  "2026-08-14T11:00:00.000Z",
  "2026-08-14T12:00:00.000Z",
  "2026-08-14T13:00:00.000Z",
];

// Deterministic clock: one timestamp per POST, last one repeats.
const clock = (times = T) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

async function boot(t, { rubric = RUBRIC, now = clock() } = {}) {
  const server = await startServer({ rubric, store: createMemoryStore(), token: TOKEN, now });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = `Bearer ${TOKEN}`) =>
    fetch(`${base}/score`, {
      method: "POST",
      headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const board = async () => (await fetch(`${base}/leaderboard`)).json();
  return { base, post, board };
}

const solve = (author, target, solved) => ({ author, target, solved, pr: 7, sha: "abc123" });

// Standings-only view of the board — drops the rubric-derived `catalog`, which
// is present whenever a rubric is loaded regardless of what has been solved.
const standings = ({ leaderboard, series, teams, teamSeries }) => ({ leaderboard, series, teams, teamSeries });

test("refuses to start without a bearer token", () => {
  assert.throws(
    () => createHandler({ store: createMemoryStore() }),
    /CTF_SCORE_BEARER_TOKEN or SCORER_TOKEN/,
  );
});

test("healthz and leaderboard are unauthenticated; everything else 404", async (t) => {
  const { base, board } = await boot(t);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.deepEqual(standings(await board()), { leaderboard: [], series: [], teams: [], teamSeries: [] });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/score`)).status, 404); // GET /score is not a route
});

test("POST /score requires the exact bearer token", async (t) => {
  const { post } = await boot(t);
  assert.equal((await post(solve("octocat", "dvwa", ["sqli-low"]), null)).status, 401);
  assert.equal((await post(solve("octocat", "dvwa", ["sqli-low"]), "Bearer wrong")).status, 401);
  assert.equal((await post(solve("octocat", "dvwa", ["sqli-low"]))).status, 202);
});

// The bearer compare is constant-time (issue #48). `timingSafeEqual` throws on
// a length mismatch, so the naive port of this check turns a wrong-length token
// into an uncaught throw — a 500, or a dead socket, where a 401 belongs. These
// pin the shapes that differ in LENGTH from the real token, which a plain
// `!==` handled for free and the hardened version has to handle on purpose.
test("a wrong-length bearer is rejected, not thrown on", async (t) => {
  const { post } = await boot(t);
  const body = solve("octocat", "dvwa", ["sqli-low"]);
  for (const auth of [
    "Bearer ", // empty token
    "Bearer s3", // a prefix of the real token
    `Bearer ${TOKEN}x`, // the real token plus a byte
    `Bearer ${TOKEN.repeat(50)}`, // far longer than the real token
    TOKEN, // no "Bearer " prefix at all
    "Basic s3cret", // right value, wrong scheme
    "", // present but empty
  ]) {
    assert.equal((await post(body, auth)).status, 401, `expected 401 for ${JSON.stringify(auth)}`);
  }
  // and the handler is still alive and still accepts the real thing
  assert.equal((await post(body)).status, 202);
});

test("POST validation: 400 on bad author, bad target, bad solved, broken JSON", async (t) => {
  const { post } = await boot(t);
  assert.equal((await post(solve("a:b", "dvwa", []))).status, 400); // key-injection grammar
  assert.equal((await post(solve("-octocat", "dvwa", []))).status, 400);
  assert.equal((await post(solve("octocat", "webgoat", []))).status, 400); // not in rubric
  assert.equal((await post(solve("octocat", "DVWA!", []))).status, 400); // charset
  assert.equal((await post(solve("octocat", "dvwa", "sqli-low"))).status, 400); // non-array
  assert.equal((await post(solve("octocat", "dvwa", [1]))).status, 400); // non-string entry
  assert.equal((await post(`{"author":`)).status, 400); // broken JSON
  assert.equal((await post(solve("octocat[bot]", "dvwa", []))).status, 202); // bot suffix OK
});

test("POST /score rejects bodies over 64 KiB with 413 (authed callers, defense-in-depth)", async (t) => {
  const { post, board } = await boot(t);
  // Valid auth, oversized JSON body: one giant string inside a real payload.
  const big = JSON.stringify(solve("octocat", "dvwa", ["x".repeat(80 * 1024)]));
  const res = await post(big);
  assert.equal(res.status, 413);
  // Nothing was recorded and a normal-size request still works afterwards.
  assert.deepEqual(standings(await board()), { leaderboard: [], series: [], teams: [], teamSeries: [] });
  assert.equal((await post(solve("octocat", "dvwa", ["sqli-low"]))).status, 202);
});

test("unknown challenge ids are dropped silently, request still 202s", async (t) => {
  const { post, board } = await boot(t);
  const res = await post(solve("octocat", "dvwa", ["sqli-low", "not-in-rubric"]));
  assert.equal(res.status, 202);
  const { leaderboard } = await board();
  assert.equal(leaderboard.length, 1);
  assert.equal(leaderboard[0].points, 1);
  assert.deepEqual(leaderboard[0].apps.dvwa, { solved: 1, total: 1, solvedIds: ["sqli-low"] });
});

test("monotonic: replaying a solve changes neither points nor lastSolveAt", async (t) => {
  const { post, board } = await boot(t);
  await post(solve("octocat", "dvwa", ["sqli-low"])); // T[0]
  const first = await board();
  await post(solve("octocat", "dvwa", ["sqli-low"])); // replay at T[1]
  const second = await board();
  assert.equal(first.leaderboard[0].lastSolveAt, T[0]);
  assert.deepEqual(second, first);
});

test("leaderboard pins the full lambda.ts contract shape", async (t) => {
  const { post, board } = await boot(t);
  await post(solve("alice", "juice-shop", ["reflected-xss-search", "sql-injection-login"])); // T[0]
  await post(solve("alice", "dvwa", ["sqli-low"])); // T[1]
  await post(solve("bob", "juice-shop", ["sql-injection-login"])); // T[2]
  assert.deepEqual(await board(), {
    leaderboard: [
      {
        rank: 1,
        author: "alice",
        points: 16,
        lastSolveAt: T[1],
        apps: {
          dvwa: { solved: 1, total: 1, solvedIds: ["sqli-low"] },
          "juice-shop": { solved: 2, total: 2, solvedIds: ["reflected-xss-search", "sql-injection-login"] },
        },
      },
      {
        rank: 2,
        author: "bob",
        points: 5,
        lastSolveAt: T[2],
        apps: {
          dvwa: { solved: 0, total: 1, solvedIds: [] },
          "juice-shop": { solved: 1, total: 2, solvedIds: ["sql-injection-login"] },
        },
      },
    ],
    series: [
      {
        login: "alice",
        // Both juice-shop ids land on T[0] (one POST -> one timestamp);
        // "reflected-xss-search" < "sql-injection-login" breaks the tie.
        points: [
          { t: T[0], score: 10 },
          { t: T[0], score: 15 },
          { t: T[1], score: 16 },
        ],
      },
      { login: "bob", points: [{ t: T[2], score: 5 }] },
    ],
    teams: [], // no team data on this store -> empty rollup
    teamSeries: [],
    catalog: {
      dvwa: [{ id: "sqli-low", name: "SQL injection (low) is patched", points: 1, owasp: null }],
      "juice-shop": [
        { id: "reflected-xss-search", name: "Search box no longer reflects HTML", points: 10, owasp: null },
        { id: "sql-injection-login", name: "Login rejects SQL injection", points: 5, owasp: null },
      ],
    },
  });
});

test("ties break by earlier lastSolveAt, then author asc", async (t) => {
  const now = clock([T[0], T[1], T[2], T[2]]);
  const { post, board } = await boot(t, { rubric: null, now });
  // All four score 1 point; zed solves before abe, alpha and zeta tie exactly.
  await post(solve("zed", "app", ["a"])); // T[0]
  await post(solve("abe", "app", ["b"])); // T[1]
  await post(solve("zeta", "app", ["c"])); // T[2]
  await post(solve("alpha", "app", ["d"])); // T[2]
  const { leaderboard } = await board();
  assert.deepEqual(
    leaderboard.map((e) => [e.rank, e.author]),
    [
      [1, "zed"], // earliest solve wins the points tie despite author order
      [2, "abe"],
      [3, "alpha"], // exact-timestamp tie: author asc
      [4, "zeta"],
    ],
  );
});

test("POST /score returns 503 while the store reports paused", async (t) => {
  const store = createMemoryStore();
  store.__setPaused(true);
  const server = await startServer({ rubric: RUBRIC, store, token: TOKEN, now: clock() });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/score`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(solve("octocat", "dvwa", ["sqli-low"])),
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "scoring is paused" });
  const board = await (await fetch(`${base}/leaderboard`)).json();
  // Nothing was recorded, so the standings are empty — but `catalog` is
  // rubric-derived, independent of solves, so it is still present.
  assert.deepEqual(board, {
    leaderboard: [],
    series: [],
    teams: [],
    teamSeries: [],
    catalog: {
      dvwa: [{ id: "sqli-low", name: "SQL injection (low) is patched", points: 1, owasp: null }],
      "juice-shop": [
        { id: "reflected-xss-search", name: "Search box no longer reflects HTML", points: 10, owasp: null },
        { id: "sql-injection-login", name: "Login rejects SQL injection", points: 5, owasp: null },
      ],
    },
  });
});

test("POST /score records normally when the store is not paused", async (t) => {
  const { post, board } = await boot(t); // fresh memory store defaults to unpaused
  assert.equal((await post(solve("octocat", "dvwa", ["sqli-low"]))).status, 202);
  assert.equal((await board()).leaderboard.length, 1);
});

test("no-rubric degenerate mode: 1 point per solve, totals from distinct ids seen", async (t) => {
  const { post, board } = await boot(t, { rubric: null });
  assert.equal((await post(solve("octocat", "anything-goes", ["a", "b"]))).status, 202);
  assert.equal((await post(solve("hubot", "anything-goes", ["b", "c", "Bad_Id"]))).status, 202);
  assert.equal((await post(solve("octocat", "Bad_Target", ["a"]))).status, 400); // charset still applies
  assert.deepEqual(await board(), {
    leaderboard: [
      {
        rank: 1,
        author: "octocat",
        points: 2,
        lastSolveAt: T[0],
        apps: { "anything-goes": { solved: 2, total: 3, solvedIds: ["a", "b"] } },
      },
      {
        rank: 2,
        author: "hubot",
        points: 2,
        lastSolveAt: T[1],
        apps: { "anything-goes": { solved: 2, total: 3, solvedIds: ["b", "c"] } },
      },
    ],
    series: [], // no rubric -> no per-challenge points to accumulate
    teams: [],
    teamSeries: [],
    catalog: {}, // no rubric -> no per-challenge metadata
  });
});

// buildLeaderboard's `series` field: cumulative score-over-time history for
// the top players, feeding the app's CTFd-style line chart (D2). Exercised
// directly against the store so timestamps and out-of-order writes are fully
// controlled, rather than through the clock-driven HTTP surface above.
test("series: cumulative step series per player, out-of-order writes still sort ascending", async (t) => {
  const store = createMemoryStore();
  // Written out of chronological order: juice-shop (T[1]) is recorded before
  // dvwa (T[0]) — the series must still come out ascending by timestamp.
  await store.recordSolves("juice-shop", "alice", ["reflected-xss-search"], T[1]); // 10 pts
  await store.recordSolves("dvwa", "alice", ["sqli-low"], T[0]); // 1 pt
  await store.recordSolves("juice-shop", "bob", ["sql-injection-login"], T[2]); // 5 pts

  const { entries, series } = await buildLeaderboard({
    store,
    rubric: RUBRIC,
    targets: ["dvwa", "juice-shop"],
  });

  assert.deepEqual(series, [
    {
      login: "alice",
      points: [
        { t: T[0], score: 1 },
        { t: T[1], score: 11 },
      ],
    },
    { login: "bob", points: [{ t: T[2], score: 5 }] },
  ]);
  // Last point of each series matches that player's final leaderboard score.
  for (const s of series) {
    const last = s.points.at(-1).score;
    assert.equal(last, entries.find((e) => e.author === s.login).points);
  }
});

test("series: rubric = null yields no series (no per-challenge points to accumulate)", async (t) => {
  const store = createMemoryStore();
  await store.recordSolves("app", "octocat", ["a"], T[0]);
  const { series } = await buildLeaderboard({ store, rubric: null, targets: ["app"] });
  assert.deepEqual(series, []);
});

test("series: single player, single solve produces one point", async (t) => {
  const store = createMemoryStore();
  await store.recordSolves("dvwa", "solo", ["sqli-low"], T[0]);
  const { series } = await buildLeaderboard({ store, rubric: RUBRIC, targets: ["dvwa", "juice-shop"] });
  assert.deepEqual(series, [{ login: "solo", points: [{ t: T[0], score: 1 }] }]);
});

test("series: capped at the top 10 players by final score", async (t) => {
  const store = createMemoryStore();
  const stamps = Array.from(
    { length: 11 },
    (_, i) => new Date(Date.parse("2026-08-14T09:00:00.000Z") + i * 60_000).toISOString(),
  );
  // 11 players, one solve each, all worth 1 point (dvwa's sqli-low has no
  // explicit `points` -> defaults to 1) — ranking falls back to earliest
  // lastSolveAt, so p0..p9 (earliest 10) make the cut and p10 does not.
  for (let i = 0; i < stamps.length; i++) {
    await store.recordSolves("dvwa", `p${i}`, ["sqli-low"], stamps[i]);
  }
  const { series } = await buildLeaderboard({ store, rubric: RUBRIC, targets: ["dvwa", "juice-shop"] });
  assert.equal(series.length, 10);
  assert.deepEqual(
    series.map((s) => s.login),
    Array.from({ length: 10 }, (_, i) => `p${i}`),
  );
});

// --- Team-aware rollup (A2). buildLeaderboard reads store.getTeams() and adds
// `teams` + `teamSeries` alongside the individual `entries`/`series`, unioning
// each team's members' solves so a flag solved by two members counts once. ---

const teamStore = (teams) => createMemoryStore({ teams });
const TARGETS = ["dvwa", "juice-shop"];

test("team rollup: same flag solved by two members counts once, not doubled", async () => {
  const store = teamStore([{ slug: "red", name: "Red", captain: "alice", members: ["alice", "bob"] }]);
  await store.recordSolves("dvwa", "alice", ["sqli-low"], T[1]);
  await store.recordSolves("dvwa", "bob", ["sqli-low"], T[0]); // same flag, earlier
  const { teams } = await buildLeaderboard({ store, rubric: RUBRIC, targets: TARGETS });
  assert.equal(teams.length, 1);
  assert.equal(teams[0].points, 1); // ONCE, not 2
  assert.equal(teams[0].lastSolveAt, T[0]); // union keeps the MIN at per flag
  assert.deepEqual(teams[0].apps.dvwa, { solved: 1, total: 1, solvedIds: ["sqli-low"] });
});

test("team rollup: disjoint flags sum across members", async () => {
  const store = teamStore([{ slug: "red", name: "Red", captain: "alice", members: ["alice", "bob"] }]);
  await store.recordSolves("juice-shop", "alice", ["reflected-xss-search"], T[0]); // 10
  await store.recordSolves("juice-shop", "bob", ["sql-injection-login"], T[1]); // 5
  const { teams } = await buildLeaderboard({ store, rubric: RUBRIC, targets: TARGETS });
  assert.equal(teams[0].points, 15);
  assert.deepEqual(teams[0].apps["juice-shop"], {
    solved: 2,
    total: 2,
    solvedIds: ["reflected-xss-search", "sql-injection-login"],
  });
  assert.equal(teams[0].lastSolveAt, T[1]);
});

test("team rollup: a solve recorded for a login before it appears in getTeams still rolls in", async () => {
  // Rollup is by membership at read time, so a historical solve counts
  // retroactively once the login is a member — seed both, then assert.
  const store = teamStore([{ slug: "blue", name: "Blue", captain: "carol", members: ["carol"] }]);
  await store.recordSolves("dvwa", "carol", ["sqli-low"], T[0]);
  const { teams } = await buildLeaderboard({ store, rubric: RUBRIC, targets: TARGETS });
  assert.equal(teams[0].points, 1);
  assert.equal(teams[0].lastSolveAt, T[0]);
});

test("team rollup: a solo team's points equal that member's individual points", async () => {
  const store = teamStore([{ slug: "solo", name: "Solo", captain: "dave", members: ["dave"] }]);
  await store.recordSolves("juice-shop", "dave", ["reflected-xss-search", "sql-injection-login"], T[0]);
  await store.recordSolves("dvwa", "dave", ["sqli-low"], T[1]);
  const { entries, teams } = await buildLeaderboard({ store, rubric: RUBRIC, targets: TARGETS });
  const dave = entries.find((e) => e.author === "dave");
  assert.equal(teams[0].points, dave.points);
  assert.equal(teams[0].points, 16);
  assert.equal(teams[0].lastSolveAt, dave.lastSolveAt);
  assert.deepEqual(teams[0].members, ["dave"]);
  assert.equal(teams[0].captain, "dave");
});

test("teamSeries: cumulative and deduped — a shared flag adds once at the earlier timestamp", async () => {
  const store = teamStore([{ slug: "red", name: "Red", captain: "alice", members: ["alice", "bob"] }]);
  await store.recordSolves("juice-shop", "alice", ["reflected-xss-search"], T[0]); // 10 @ T0
  await store.recordSolves("dvwa", "bob", ["sqli-low"], T[1]); // 1 @ T1
  await store.recordSolves("dvwa", "alice", ["sqli-low"], T[2]); // dup of bob's flag, later
  const { teamSeries, teams } = await buildLeaderboard({ store, rubric: RUBRIC, targets: TARGETS });
  assert.deepEqual(teamSeries, [
    {
      slug: "red",
      name: "Red",
      // sqli-low deduped to its earlier at (T1, bob); union = {xss @T0, sqli @T1}.
      points: [
        { t: T[0], score: 10 },
        { t: T[1], score: 11 },
      ],
    },
  ]);
  assert.equal(teams[0].points, 11); // 10 + 1, shared flag once
});

test("team ranking: equal points break by earlier lastSolveAt", async () => {
  const store = teamStore([
    { slug: "late", name: "Late", captain: "x", members: ["x"] },
    { slug: "early", name: "Early", captain: "y", members: ["y"] },
  ]);
  await store.recordSolves("dvwa", "y", ["sqli-low"], T[0]); // early: 1 @ T0
  await store.recordSolves("dvwa", "x", ["sqli-low"], T[1]); // late: 1 @ T1
  const { teams } = await buildLeaderboard({ store, rubric: RUBRIC, targets: TARGETS });
  assert.deepEqual(
    teams.map((tm) => [tm.rank, tm.slug]),
    [
      [1, "early"], // equal points -> earlier lastSolveAt ranks first
      [2, "late"],
    ],
  );
});

test("team rollup is additive: individual entries/series are unchanged by the team columns", async () => {
  const seed = async (store) => {
    await store.recordSolves("juice-shop", "alice", ["reflected-xss-search"], T[0]);
    await store.recordSolves("dvwa", "bob", ["sqli-low"], T[1]);
  };
  const withTeams = teamStore([{ slug: "red", name: "Red", captain: "alice", members: ["alice", "bob"] }]);
  const without = createMemoryStore();
  await seed(withTeams);
  await seed(without);
  const a = await buildLeaderboard({ store: withTeams, rubric: RUBRIC, targets: TARGETS });
  const b = await buildLeaderboard({ store: without, rubric: RUBRIC, targets: TARGETS });
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual(a.series, b.series);
  assert.deepEqual(b.teams, []); // no team data -> empty rollup
  assert.deepEqual(b.teamSeries, []);
});

test("teamSeries: empty without a rubric (no per-challenge points to accumulate)", async () => {
  const store = teamStore([{ slug: "red", name: "Red", captain: "alice", members: ["alice"] }]);
  await store.recordSolves("app", "alice", ["a"], T[0]);
  const { teams, teamSeries } = await buildLeaderboard({ store, rubric: null, targets: ["app"] });
  assert.equal(teams[0].points, 1); // degenerate mode: 1 point per solve
  assert.deepEqual(teamSeries, []);
});

// --- GET /challenges --------------------------------------------------------
//
// The app's /challenges page fetches this and falls back to static per-app
// cards when it fails. It failed on every request for a long time — the route
// simply did not exist — and the only symptom was an error logged per render.

test("GET /challenges serves the rubric catalogue, unauthenticated", async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/challenges`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // Fixture: dvwa has 1 challenge, juice-shop 2.
  assert.equal(body.total, 3);
  assert.deepEqual(body.counts, { dvwa: 1, "juice-shop": 2 });
  assert.equal(body.challenges.length, 3);

  const one = body.challenges.find((c) => c.id === "reflected-xss-search");
  assert.deepEqual(one, {
    app: "juice-shop",
    id: "reflected-xss-search",
    name: "Search box no longer reflects HTML",
    points: 10,
    owasp: null,
  });
});

// The app resolves a code into its label and link (apps/web/src/lib/owasp.ts).
// Sending a code/label/url object from here would put OWASP's taxonomy in two
// repos and let them drift.
test("GET /challenges sends the bare OWASP code, never a presentation object", async (t) => {
  const { base } = await boot(t);
  const body = await (await fetch(`${base}/challenges`)).json();
  for (const c of body.challenges) {
    assert.ok(c.owasp === null || typeof c.owasp === "string", `owasp must be a code or null, got ${JSON.stringify(c.owasp)}`);
  }
});

// Degenerate mode has no per-challenge metadata at all. An empty catalogue is
// a different answer from a 404 — the app reads "no catalogue here" and stays
// on its static cards, which is correct; a 404 is what it used to get from
// EVERY deployment and could not tell apart from a broken one.
test("GET /challenges reports an empty catalogue without a rubric, not a 404", async (t) => {
  const { base } = await boot(t, { rubric: null });
  const res = await fetch(`${base}/challenges`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenges: [], counts: {}, total: 0 });
});

// Non-vacuity for the counts above: the route must not invent a target the
// rubric never defined.
test("GET /challenges lists only targets the rubric actually defines", async (t) => {
  const { base } = await boot(t);
  const body = await (await fetch(`${base}/challenges`)).json();
  assert.deepEqual([...new Set(body.challenges.map((c) => c.app))].sort(), ["dvwa", "juice-shop"]);
});

// `serve()` is the process entry compose runs; until now no test called it, so
// PORT parsing and the store selection were unexercised. Number("abc") is NaN
// and listen(NaN) binds a random port — refuse instead.
import { serve } from "../src/serve.js";
const RUBRIC_DIR = fileURLToPath(new URL("./fixtures/rubric-valid/", import.meta.url));

test("serve(): refuses a non-numeric PORT before listening", async () => {
  await assert.rejects(
    serve({ SCORER_TOKEN: TOKEN, RUBRIC_DIR, PORT: "abc" }, { log: () => {} }),
    /PORT must be an integer/,
  );
});

test("serve(): boots the memory store and answers /healthz", async (t) => {
  const logs = [];
  const server = await serve({ SCORER_TOKEN: TOKEN, RUBRIC_DIR, PORT: "0" }, { log: (m) => logs.push(m) });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(res.status, 200);
  assert.match(logs[0], /memory store/);
});

test("serve(): refuses a whitespace-only PORT (Number(' ') is 0, an ephemeral port)", async () => {
  await assert.rejects(
    serve({ SCORER_TOKEN: TOKEN, RUBRIC_DIR, PORT: " " }, { log: () => {} }),
    /PORT must be an integer/,
  );
});

// --- solve time = the score comment's time (`at`) ---------------------------
//
// sync sends each score with `at`, the score comment's GitHub `updated_at`.
// The scorer records that as the solve time, and judges the scoring window,
// the manual freeze and the master-reset epoch against it, not against when
// the score happened to arrive.

const NOW = "2026-08-14T12:00:00.000Z";
const LAUNCHED = { paused: false, pausedSince: null, startsAt: "2026-08-14T09:00:00.000Z", endsAt: null, resetAt: null, pauses: [] };

async function bootWith(t, { policy = LAUNCHED, now = () => NOW, rubric = RUBRIC } = {}) {
  const store = createMemoryStore();
  if (policy) store.__setPolicy(policy);
  const server = await startServer({ rubric, store, token: TOKEN, now });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    fetch(`${base}/score`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const board = async () => (await fetch(`${base}/leaderboard`)).json();
  return { store, post, board };
}

const timed = (author, target, solved, at) => ({ ...solve(author, target, solved), at });

test("`at` is the recorded solve time, normalised to ISO-8601 with milliseconds", async (t) => {
  const { store, post } = await bootWith(t);
  // GitHub's updated_at carries no milliseconds; stored times are compared as
  // strings, so the scorer stores one shape.
  assert.equal((await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"))).status, 202);
  assert.deepEqual(await store.getSolves("dvwa"), { "octocat:sqli-low": "2026-08-14T10:00:00.000Z" });
});

test("a backlog ingested late keeps each solve's own comment time", async (t) => {
  const { board, post } = await bootWith(t);
  assert.equal((await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T09:30:00Z"))).status, 202);
  assert.equal((await post(timed("hubot", "juice-shop", ["sql-injection-login"], "2026-08-14T09:45:00Z"))).status, 202);
  const { leaderboard } = await board();
  const at = Object.fromEntries(leaderboard.map((e) => [e.author, e.lastSolveAt]));
  assert.deepEqual(at, { octocat: "2026-08-14T09:30:00.000Z", hubot: "2026-08-14T09:45:00.000Z" });
});

test("the first time a solve was seen is kept: a later comment time does not move it", async (t) => {
  const { store, post } = await bootWith(t);
  await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"));
  await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T11:00:00Z"));
  assert.deepEqual(await store.getSolves("dvwa"), { "octocat:sqli-low": "2026-08-14T10:00:00.000Z" });
});

test("a points tie goes to the earlier comment time, not the earlier arrival", async (t) => {
  const { board, post } = await bootWith(t);
  // zed's score ARRIVES first but its comment is later.
  await post(timed("zed", "juice-shop", ["sql-injection-login"], "2026-08-14T10:30:00Z"));
  await post(timed("abe", "juice-shop", ["sql-injection-login"], "2026-08-14T10:00:00Z"));
  const { leaderboard } = await board();
  assert.deepEqual(leaderboard.map((e) => [e.rank, e.author]), [[1, "abe"], [2, "zed"]]);
});

test("an absent `at` falls back to the arrival time (an older sync)", async (t) => {
  const { store, post } = await bootWith(t);
  assert.equal((await post(solve("octocat", "dvwa", ["sqli-low"]))).status, 202);
  assert.deepEqual(await store.getSolves("dvwa"), { "octocat:sqli-low": NOW });
});

test("an unparseable or non-string `at` is refused with 400 and records nothing", async (t) => {
  const { store, post } = await bootWith(t);
  for (const at of ["yesterday", "", 1755160000000, {}, true]) {
    const res = await post(timed("octocat", "dvwa", ["sqli-low"], at));
    assert.equal(res.status, 400, `at=${JSON.stringify(at)}`);
    assert.deepEqual(await res.json(), { error: "invalid at" });
  }
  assert.deepEqual(await store.getSolves("dvwa"), {});
});

test("an `at` more than five minutes ahead is clamped to now; within the skew it is kept", async (t) => {
  const { store, post } = await bootWith(t);
  assert.equal((await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T12:05:00.001Z"))).status, 202);
  assert.equal((await post(timed("hubot", "dvwa", ["sqli-low"], "2026-08-14T12:05:00.000Z"))).status, 202);
  assert.deepEqual(await store.getSolves("dvwa"), {
    "octocat:sqli-low": NOW,
    "hubot:sqli-low": "2026-08-14T12:05:00.000Z",
  });
});

test("an `at` before the master-reset epoch is refused with a final 422", async (t) => {
  const resetAt = String(Date.parse("2026-08-14T10:00:00.000Z"));
  const { store, post } = await bootWith(t, { policy: { ...LAUNCHED, resetAt } });
  const res = await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T09:59:59Z"));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).refused, "pre-reset");
  assert.equal((await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"))).status, 202);
  assert.deepEqual(await store.getSolves("dvwa"), { "octocat:sqli-low": "2026-08-14T10:00:00.000Z" });
});

test("an `at` outside the scoring window is refused with a final 422, judged on the comment time", async (t) => {
  const window = { ...LAUNCHED, startsAt: "2026-08-14T09:00:00.000Z", endsAt: "2026-08-14T11:00:00.000Z" };
  const { store, post } = await bootWith(t, { policy: window });
  for (const at of ["2026-08-14T08:59:59Z", "2026-08-14T11:00:01Z"]) {
    const res = await post(timed("octocat", "dvwa", ["sqli-low"], at));
    assert.equal(res.status, 422, at);
    assert.equal((await res.json()).refused, "outside-window");
  }
  // The window has closed by NOW (12:00), but this comment landed during
  // play: it counts, however late it arrives.
  assert.equal((await post(timed("hubot", "dvwa", ["sqli-low"], "2026-08-14T10:59:00Z"))).status, 202);
  assert.deepEqual(Object.keys(await store.getSolves("dvwa")), ["hubot:sqli-low"]);
});

test("an `at` on an event that was never launched is refused with a final 422", async (t) => {
  const { post } = await bootWith(t, { policy: { ...LAUNCHED, startsAt: null } });
  const res = await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).refused, "outside-window");
});

test("an `at` inside a logged pause is refused with a final 422, even after the resume", async (t) => {
  const pauses = ['{"from":"2026-08-14T10:00:00.000Z","to":"2026-08-14T10:30:00.000Z"}'];
  const { store, post } = await bootWith(t, { policy: { ...LAUNCHED, pauses } });
  const res = await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:15:00Z"));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).refused, "paused");
  assert.equal((await post(timed("hubot", "dvwa", ["sqli-low"], "2026-08-14T10:30:00Z"))).status, 202);
  assert.deepEqual(Object.keys(await store.getSolves("dvwa")), ["hubot:sqli-low"]);
});

test("while frozen, a comment from BEFORE the pause still scores; one from during it does not", async (t) => {
  const policy = { ...LAUNCHED, paused: true, pausedSince: "2026-08-14T11:00:00.000Z" };
  const { store, post } = await bootWith(t, { policy });
  store.__setPaused(true); // the arrival-time freeze is on: it must not decide
  assert.equal((await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:59:59Z"))).status, 202);
  const res = await post(timed("hubot", "dvwa", ["sqli-low"], "2026-08-14T11:00:00Z"));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).refused, "paused");
  assert.deepEqual(Object.keys(await store.getSolves("dvwa")), ["octocat:sqli-low"]);
});

// A freeze set with no recorded start (set by hand, or before the pause log
// existed): when it began is unknown, so a final verdict could refuse a score
// made before it. Answered 503 instead, which sync retries.
test("a freeze with no recorded start answers 503 (retry), not a final refusal", async (t) => {
  const { store, post } = await bootWith(t, { policy: { ...LAUNCHED, paused: true, pausedSince: null } });
  const res = await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "scoring is paused" });
  assert.deepEqual(await store.getSolves("dvwa"), {});
});

test("the window and reset refusals stay final even under a freeze with no recorded start", async (t) => {
  const { post } = await bootWith(t, { policy: { ...LAUNCHED, paused: true, pausedSince: null, startsAt: null } });
  const res = await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).refused, "outside-window");
});

test("an unreadable scoring policy fails OPEN: the score is recorded at its comment time", async (t) => {
  const { store, post } = await bootWith(t, { policy: null });
  assert.equal((await post(timed("octocat", "dvwa", ["sqli-low"], "2026-08-14T10:00:00Z"))).status, 202);
  assert.deepEqual(await store.getSolves("dvwa"), { "octocat:sqli-low": "2026-08-14T10:00:00.000Z" });
});
