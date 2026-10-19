import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadRubric } from "../src/rubric.js";
import { createRedisStore } from "../src/store.js";
import { buildLeaderboard } from "../src/serve.js";

const rubric = loadRubric(fileURLToPath(new URL("../rubric.owasp/", import.meta.url)));
const T0 = "2026-08-14T10:00:00.000Z";
const T1 = "2026-08-14T11:00:00.000Z";
const T2 = "2026-08-14T12:00:00.000Z";
const solves = {
  "alice:challenge-11-no-source-too-small": T0,
  "alice:challenge-6-arbitrary-file-write": T1,
  "bob:challenge-11-no-source-too-small": T1,
  "bob:challenge-73-ssrf": T2,
  "carol:challenge-17-csp-bypass": T0,
  "carol:challenge-4-admin-registration": T1,
};
const teams = {
  alpha: { name: "Alpha", captain: "alice", members: ["bob", "alice"] },
  beta: { name: "Beta", captain: "carol", members: ["carol"] },
};

for (const { name, pages, order } of [
  {
    name: "distinct keys across pages",
    pages: [["7", ["ctf:team:beta:members"]], ["0", ["ctf:team:alpha:members"]]],
    order: ["beta", "alpha"],
  },
  {
    name: "a duplicate key across pages",
    pages: [["7", ["ctf:team:alpha:members"]], ["0", ["ctf:team:alpha:members", "ctf:team:beta:members"]]],
    order: ["alpha", "beta"],
  },
  {
    name: "a duplicate key within a page",
    pages: [["0", ["ctf:team:alpha:members", "ctf:team:alpha:members", "ctf:team:beta:members"]]],
    order: ["alpha", "beta"],
  },
]) {
  test(`redis team discovery: ${name} yields one ranked row and series per team`, async () => {
    const commands = [];
    const store = createRedisStore({
      url: "http://srh:80",
      token: "test-token",
      fetchImpl: async (_url, options) => {
        const batch = JSON.parse(options.body);
        commands.push(...batch);
        const results = batch.map(([command, key, field]) => {
          if (command === "SCAN") {
            assert.ok(key === "0" || (key === "7" && pages.length === 2));
            return pages[key === "0" ? 0 : 1];
          }
          if (command === "HGETALL") {
            assert.equal(key, "ctf:solves:juice-shop");
            return Object.entries(solves).flat();
          }
          const slug = key.split(":")[2];
          assert.ok(Object.hasOwn(teams, slug), `unexpected team key: ${key}`);
          if (command === "HGET") return teams[slug][field];
          if (command === "SMEMBERS") return teams[slug].members;
          assert.fail(`unexpected command: ${command}`);
        });
        return new Response(JSON.stringify(results.map((result) => ({ result }))));
      },
    });

    const board = await buildLeaderboard({ store, rubric, targets: ["juice-shop"] });
    assert.deepEqual({
      teams: board.teams.map(({ rank, slug, name, points }) => ({ rank, slug, name, points })),
      series: board.teamSeries.map(({ slug }) => slug),
    }, {
      teams: [
        { rank: 1, slug: "alpha", name: "Alpha", points: 18 },
        { rank: 2, slug: "beta", name: "Beta", points: 7 },
      ],
      series: ["alpha", "beta"],
    });
    assert.deepEqual(board.teams.map(({ captain, members }) => ({ captain, members })), [
      { captain: "alice", members: ["alice", "bob"] },
      { captain: "carol", members: ["carol"] },
    ]);
    assert.deepEqual(board.teamSeries, [
      { slug: "alpha", name: "Alpha", points: [{ t: T0, score: 6 }, { t: T1, score: 12 }, { t: T2, score: 18 }] },
      { slug: "beta", name: "Beta", points: [{ t: T0, score: 4 }, { t: T1, score: 7 }] },
    ]);
    assert.deepEqual(board.entries.map(({ rank, author, points }) => ({ rank, author, points })), [
      { rank: 1, author: "alice", points: 12 },
      { rank: 2, author: "bob", points: 12 },
      { rank: 3, author: "carol", points: 7 },
    ]);
    assert.deepEqual(board.series.map(({ login, points }) => [login, points.at(-1).score]), [
      ["alice", 12], ["bob", 12], ["carol", 7],
    ]);
    assert.deepEqual(commands.filter(([command]) => command === "SCAN").map(([, cursor]) => cursor), pages.length === 2 ? ["0", "7"] : ["0"]);
    assert.deepEqual(commands.filter(([command]) => command === "HGET" || command === "SMEMBERS"), order.flatMap((slug) => [
      ["HGET", `ctf:team:${slug}`, "name"],
      ["HGET", `ctf:team:${slug}`, "captain"],
      ["SMEMBERS", `ctf:team:${slug}:members`],
    ]));
  });
}
