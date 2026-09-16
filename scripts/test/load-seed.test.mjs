// The pure half of scripts/load-seed.mjs (issue #439): what a run writes,
// that --clean removes exactly the harness's own rows from whatever the store
// holds (no catalogue, no --count), and the fail-closed / log-safety seams.
// Run: node --test scripts/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGGREGATE_KEYS,
  assertRedisUrl,
  attemptRow,
  buildCommands,
  cleanCommands,
  errorLabel,
  isSeededField,
  isSeededKey,
  liveModules,
  loginFor,
  partitionTeams,
  pickSubset,
  resolveCatalogue,
  rng,
} from "../load-seed.mjs";

const catalogue = {
  quiz: [{ id: "q1", points: 10, choices: ["a"] }, { id: "q2", points: 20, choices: ["b"] }, { id: "q3", points: 30, choices: ["c"] }],
  classic: [{ id: "c1", points: 100 }, { id: "c2", points: 200 }],
  sd: { dvwa: ["ch-1", "ch-2", "ch-3"], webgoat: ["w-1"] },
};

/** What SCAN + HKEYS would hand the clean after these seed commands ran on an otherwise-empty store. */
function storeAfter(cmds, extra = { keys: [], hashFields: {} }) {
  const keys = new Set(extra.keys);
  const hashFields = Object.fromEntries(Object.entries(extra.hashFields).map(([k, v]) => [k, [...v]]));
  for (const c of cmds) {
    if (AGGREGATE_KEYS.includes(c[1]) || c[1].startsWith("ctf:solves:")) (hashFields[c[1]] ||= []).push(c[2]);
    else keys.add(c[1]);
  }
  return { keys: [...keys], hashFields };
}

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

test("clean is the inverse: every key/field the seed wrote is deleted, and nothing outside the harness's shape", () => {
  const seed = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  // A real contestant's rows sit beside ours in every family; none may go.
  const real = {
    keys: ["ctf:user:octocat", "ctf:user:load-master", "ctf:team:load-team", "ctf:team:blue:members", "ctf:quiz:answers:load-dev"],
    hashFields: { "ctf:quiz:points": ["octocat", "load-master"], "ctf:solves:dvwa": ["octocat:ch-1", "load-master:ch-2"] },
  };
  const clean = cleanCommands(storeAfter(seed.cmds, real));
  const written = new Set();
  for (const c of seed.cmds) {
    if (c[0] === "SADD") written.add(c[1]);
    else if (AGGREGATE_KEYS.includes(c[1]) || c[1].startsWith("ctf:solves:")) written.add(`${c[1]}#${c[2]}`);
    else written.add(c[1]);
  }
  const deleted = new Set();
  for (const c of clean.cmds) {
    if (c[0] === "DEL") for (const k of c.slice(1)) deleted.add(k);
    if (c[0] === "HDEL") for (const f of c.slice(2)) deleted.add(`${c[1]}#${f}`);
  }
  for (const w of written) assert.ok(deleted.has(w), `not cleaned: ${w}`);
  for (const d of deleted) assert.match(d, /load-\d{4}|load-team-\d{2}/, `clean touches a non-harness key: ${d}`);
  for (const k of real.keys) assert.ok(!deleted.has(k), `clean deleted a real key: ${k}`);
  for (const [k, fs] of Object.entries(real.hashFields)) for (const f of fs) assert.ok(!deleted.has(`${k}#${f}`), `clean deleted a real field: ${k}#${f}`);
});

// The Major from review: a challenge dropped from the catalogue, or a module
// switched off, after seeding must not strand a field. The clean reads the
// store, not the catalogue, so it does not know or care what changed.
test("clean removes seeded solves for a challenge no longer in the catalogue, and a stale --count is irrelevant", () => {
  const seed = buildCommands({ count: 30, catalogue, now: 1_000_000_000_000 });
  const store = storeAfter(seed.cmds);
  // Pretend dvwa was removed and a target the seed never saw carries an old field of ours.
  store.hashFields["ctf:solves:retired-target"] = ["load-0007:gone-1", "octocat:gone-1"];
  const clean = cleanCommands(store);
  const hdels = clean.cmds.filter((c) => c[0] === "HDEL");
  const dvwaFields = hdels.filter((c) => c[1] === "ctf:solves:dvwa").flatMap((c) => c.slice(2));
  const seededDvwa = seed.cmds.filter((c) => c[1] === "ctf:solves:dvwa").map((c) => c[2]);
  for (const f of seededDvwa) assert.ok(dvwaFields.includes(f), `stranded: ${f}`);
  const retired = hdels.find((c) => c[1] === "ctf:solves:retired-target");
  assert.deepEqual(retired.slice(2), ["load-0007:gone-1"]);
  assert.equal(clean.fields, seededDvwa.length + seed.cmds.filter((c) => c[1] === "ctf:solves:webgoat").length + 1 + seed.cmds.filter((c) => AGGREGATE_KEYS.includes(c[1])).length);
});

test("the ownership predicates accept exactly the harness's shape", () => {
  assert.ok(isSeededKey("ctf:user:load-0001"));
  assert.ok(isSeededKey("ctf:team:load-team-07"));
  assert.ok(isSeededKey("ctf:team:load-team-107:members"));
  assert.ok(!isSeededKey("ctf:user:load-master"), "a real login that happens to start with load-");
  assert.ok(!isSeededKey("ctf:user:load-00001"), "five digits is not ours");
  assert.ok(!isSeededKey("ctf:team:load-team"));
  assert.ok(!isSeededKey("ctf:quiz:questions"));
  assert.ok(isSeededField("ctf:solves:dvwa", "load-0042:ch-9"));
  assert.ok(!isSeededField("ctf:solves:dvwa", "load-dev:ch-9"));
  assert.ok(isSeededField("ctf:quiz:points", "load-0042"));
  assert.ok(!isSeededField("ctf:quiz:points", "load-0042:x"));
  assert.ok(!isSeededField("ctf:quiz:questions", "load-0042"), "not a hash the seed writes");
});

// Fail closed: the seed refuses to guess which modules are live.
test("liveModules parses the stored list and throws on anything it cannot read", () => {
  assert.equal(liveModules({}), null);
  assert.equal(liveModules({ enabledModuleIds: "" }), null);
  assert.deepEqual(liveModules({ enabledModuleIds: '["quiz","classic"]' }), ["quiz", "classic"]);
  assert.throws(() => liveModules({ enabledModuleIds: "{not json" }), /not valid JSON/);
  assert.throws(() => liveModules({ enabledModuleIds: '{"quiz":true}' }), /not a list/);
  assert.throws(() => liveModules({ enabledModuleIds: "[1,2]" }), /not a list/);
});

test("resolveCatalogue attaches only live modules and aborts when Secure Development has no scorer", () => {
  const quizRows = { q1: JSON.stringify({ id: "q1", points: 10, correct: ["a"] }), bad: "{" };
  const classicRows = { c1: JSON.stringify({ id: "c1", points: 100 }) };
  const sdChallenges = [{ app: "dvwa", id: "ch-1" }, { app: "dvwa", id: "ch-2" }];
  const all = resolveCatalogue({ enabled: null, quizRows, classicRows, sdChallenges, scorerUrl: "http://scorer:8080" });
  assert.deepEqual(all, { quiz: [{ id: "q1", points: 10, choices: ["a"] }], classic: [{ id: "c1", points: 100 }], sd: { dvwa: ["ch-1", "ch-2"] } });
  const quizOnly = resolveCatalogue({ enabled: ["quiz"], quizRows, classicRows, sdChallenges: null, scorerUrl: "" });
  assert.deepEqual(quizOnly.classic, []);
  assert.deepEqual(quizOnly.sd, {});
  assert.throws(() => resolveCatalogue({ enabled: ["secure-development"], quizRows, classicRows, sdChallenges, scorerUrl: "" }), /LEADERBOARD_API_URL is not set/);
  assert.throws(() => resolveCatalogue({ enabled: null, quizRows, classicRows, sdChallenges: null, scorerUrl: "http://scorer:8080" }), /did not answer/);
});

test("the Redis URL must be https, or http only to a private endpoint", () => {
  assert.equal(assertRedisUrl("http://srh:80").hostname, "srh");
  assert.equal(assertRedisUrl("http://localhost:8079").hostname, "localhost");
  assert.equal(assertRedisUrl("http://owasp-ctf.internal:80/").hostname, "owasp-ctf.internal");
  assert.equal(assertRedisUrl("https://eu1-xyz.upstash.io").protocol, "https:");
  assert.throws(() => assertRedisUrl("http://eu1-xyz.upstash.io"), /cleartext/);
  assert.throws(() => assertRedisUrl("http://203.0.113.9:80"), /cleartext/);
  assert.throws(() => assertRedisUrl("ftp://srh"), /must be https/);
  assert.throws(() => assertRedisUrl("not a url"), /not a URL/);
});

test("errorLabel never carries a token, a URL, a stack, or an arbitrary thrown value", () => {
  const e = new Error("fetch to https://srh:80/pipeline failed with Bearer abc.def.ghi and more");
  const label = errorLabel(e);
  assert.ok(!label.includes("abc.def"), label);
  assert.ok(!label.includes("srh:80"), label);
  assert.ok(label.startsWith("Error: "), label);
  assert.ok(!label.includes("\n"));
  assert.equal(errorLabel({ message: "object with a message and the token xyz" }), "failed (non-Error throw)");
  assert.equal(errorLabel("a string with http://host/secret"), "failed (non-Error throw)");
  assert.ok(errorLabel(new Error("x".repeat(500))).length <= 220);
});
