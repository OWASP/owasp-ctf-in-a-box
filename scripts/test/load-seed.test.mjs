// The pure half of scripts/load-seed.mjs (issue #439): what a run writes and
// that --clean is its exact inverse. Run: node --test scripts/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptRow, buildCommands, cleanCommands, loginFor, partitionTeams, pickSubset, rng } from "../load-seed.mjs";

const catalogue = {
  quiz: [{ id: "q1", points: 10, choices: ["a"] }, { id: "q2", points: 20, choices: ["b"] }, { id: "q3", points: 30, choices: ["c"] }],
  classic: [{ id: "c1", points: 100 }, { id: "c2", points: 200 }],
  sd: { dvwa: ["ch-1", "ch-2", "ch-3"], webgoat: ["w-1"] },
};

test("logins are zero-padded and prefixed so a clean can find them", () => {
  assert.equal(loginFor(1), "load-0001");
  assert.equal(loginFor(200), "load-0200");
});

test("every login lands on exactly one team of 2–4 (a trailing solo only when unavoidable)", () => {
  for (const n of [2, 3, 5, 7, 100, 200]) {
    const logins = Array.from({ length: n }, (_, i) => loginFor(i + 1));
    const teams = partitionTeams(logins, rng(n));
    const seen = teams.flatMap((t) => t.members);
    assert.deepEqual(seen, logins, `n=${n}: every login once, in order`);
    for (const t of teams) {
      assert.ok(t.members.length >= 1 && t.members.length <= 4, `n=${n}: size ${t.members.length}`);
      assert.equal(t.captain, t.members[0]);
    }
    assert.ok(teams.filter((t) => t.members.length === 1).length <= (n === 1 ? 1 : 0), `n=${n}: no solo teams`);
  }
});

test("the same seed yields the same commands (idempotent re-run)", () => {
  const a = buildCommands({ count: 50, catalogue, now: 1_000_000_000_000 });
  const b = buildCommands({ count: 50, catalogue, now: 1_000_000_000_000 });
  assert.deepEqual(a.cmds, b.cmds);
});

test("pickSubset never repeats an id and respects the bounds", () => {
  const rand = rng(7);
  for (let i = 0; i < 50; i++) {
    const out = pickSubset(["a", "b", "c", "d"], 1, 3, rand);
    assert.ok(out.length >= 1 && out.length <= 3);
    assert.equal(new Set(out).size, out.length);
  }
  assert.deepEqual(pickSubset([], 0, 6, rand), []);
});

test("attempt rows carry the four fields the app's parser reads, firstAt clamped to the window", () => {
  const earned = Date.parse("2026-09-16T01:00:00Z");
  const row = JSON.parse(attemptRow(3, earned, 10, earned - 60_000));
  assert.deepEqual(Object.keys(row).sort(), ["attempts", "firstAt", "lastAt", "lastAtMs"]);
  assert.equal(row.attempts, 3);
  assert.equal(row.lastAtMs, earned);
  assert.equal(row.firstAt, new Date(earned - 60_000).toISOString(), "clamped to the floor, not 25 min earlier");
});

test("writes only the seed's key families, and the aggregates match the per-login rows", () => {
  const { cmds } = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  const families = new Set(cmds.map((c) => c[1].replace(/load-[0-9]+|load-team-[0-9]+|(dvwa|webgoat)$/g, "*")));
  assert.deepEqual(
    [...families].sort(),
    ["ctf:classic:attempts:*", "ctf:classic:points", "ctf:classic:solved", "ctf:classic:solves:*", "ctf:quiz:answered", "ctf:quiz:answers:*", "ctf:quiz:attempts:*", "ctf:quiz:points", "ctf:solves:*", "ctf:team:*", "ctf:team:*:members", "ctf:user:*"],
  );
  // The seeder writes no catalogue and never touches solvecount or hints.
  assert.ok(!cmds.some((c) => /questions|challenges|solvecount|hints|flag/.test(c[1])));
  // quiz points aggregate == sum of that login's answers
  const answers = {};
  const points = {};
  for (const c of cmds) {
    if (c[0] === "HSET" && c[1].startsWith("ctf:quiz:answers:")) {
      const login = c[1].slice("ctf:quiz:answers:".length);
      answers[login] = (answers[login] || 0) + JSON.parse(c[3]).points;
    }
    if (c[0] === "HSET" && c[1] === "ctf:quiz:points") points[c[2]] = c[3];
  }
  assert.deepEqual(points, answers);
});

test("clean is the inverse: every key/field the seed wrote is deleted, and nothing outside the prefix", () => {
  const seed = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  const clean = cleanCommands({ count: 20, catalogue });
  const written = new Set();
  for (const c of seed.cmds) {
    if (c[0] === "SADD") written.add(c[1]);
    else if (["ctf:quiz:points", "ctf:quiz:answered", "ctf:classic:points", "ctf:classic:solved"].includes(c[1]) || c[1].startsWith("ctf:solves:")) written.add(`${c[1]}#${c[2]}`);
    else written.add(c[1]);
  }
  const deleted = new Set();
  for (const c of clean.cmds) {
    if (c[0] === "DEL") for (const k of c.slice(1)) deleted.add(k);
    if (c[0] === "HDEL") for (const f of c.slice(2)) deleted.add(`${c[1]}#${f}`);
  }
  for (const w of written) assert.ok(deleted.has(w), `not cleaned: ${w}`);
  for (const d of deleted) assert.match(d, /load-/, `clean touches a non-load key: ${d}`);
});
