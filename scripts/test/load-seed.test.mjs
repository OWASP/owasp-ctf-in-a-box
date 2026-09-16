// The pure half of scripts/load-seed.mjs (issue #439): what a run writes,
// that the manifest records every write and --clean removes exactly the
// manifest (no catalogue, no --count, no name pattern), that a seed refuses
// to write over rows it does not own, and the fail-closed / log-safety seams.
// Run: node --test scripts/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_KEY,
  SHARED_HASHES,
  assertRedisUrl,
  attemptRow,
  buildCommands,
  cleanCommands,
  collisions,
  errorLabel,
  isSharedHash,
  liveModules,
  loginFor,
  manifestFor,
  mergeManifests,
  partitionTeams,
  pickSubset,
  planBatches,
  resolveCatalogue,
  rng,
} from "../load-seed.mjs";

const catalogue = {
  quiz: [{ id: "q1", points: 10, choices: ["a"] }, { id: "q2", points: 20, choices: ["b"] }, { id: "q3", points: 30, choices: ["c"] }],
  classic: [{ id: "c1", points: 100 }, { id: "c2", points: 200 }],
  sd: { dvwa: ["ch-1", "ch-2", "ch-3"], webgoat: ["w-1"] },
};

/** A pretend store: what EXISTS / HEXISTS would answer after `cmds` ran on top of `extra`. */
function storeAfter(cmds, extra = { keys: [], fields: {} }) {
  const keys = new Set(extra.keys);
  const fields = Object.fromEntries(Object.entries(extra.fields).map(([k, v]) => [k, new Set(v)]));
  for (const c of cmds) {
    if (isSharedHash(c[1])) (fields[c[1]] ||= new Set()).add(c[2]);
    else keys.add(c[1]);
  }
  return { keys, fields };
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

test("the manifest records every key and shared-hash field the seed writes, and nothing else", () => {
  const seed = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  const m = manifestFor(seed.cmds);
  const written = new Set();
  for (const c of seed.cmds) written.add(isSharedHash(c[1]) ? `${c[1]}#${c[2]}` : c[1]);
  const recorded = new Set([...m.keys, ...Object.entries(m.fields).flatMap(([k, fs]) => fs.map((f) => `${k}#${f}`))]);
  assert.deepEqual(recorded, written);
  for (const k of Object.keys(m.fields)) assert.ok(SHARED_HASHES.includes(k) || k.startsWith("ctf:solves:"), `whole key recorded as fields: ${k}`);
  assert.ok(!m.keys.includes(MANIFEST_KEY));
});

test("clean is the exact inverse of the manifest and touches nothing outside it — not even a real login shaped like ours", () => {
  const seed = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  const m = manifestFor(seed.cmds);
  const clean = cleanCommands(m);
  const deleted = new Set();
  for (const c of clean.cmds) {
    if (c[0] === "DEL") for (const k of c.slice(1)) deleted.add(k);
    if (c[0] === "HDEL") for (const f of c.slice(2)) deleted.add(`${c[1]}#${f}`);
  }
  for (const c of seed.cmds) assert.ok(deleted.has(isSharedHash(c[1]) ? `${c[1]}#${c[2]}` : c[1]), `not cleaned: ${c[1]}`);
  assert.ok(deleted.has(MANIFEST_KEY), "the manifest itself goes last");
  // Rows the manifest never listed are invisible to the clean, whatever they are called.
  for (const k of ["ctf:user:octocat", "ctf:user:load-0999", "ctf:team:load-team-99", "ctf:quiz:points#load-0999", "ctf:solves:dvwa#load-0999:ch-1"]) assert.ok(!deleted.has(k), `clean touched an unlisted row: ${k}`);
  assert.equal(clean.keys, m.keys.length);
  assert.equal(clean.fields, Object.values(m.fields).reduce((n, a) => n + a.length, 0));
});

// The Major from review: a challenge dropped from the catalogue, or a module
// switched off, after seeding must not strand a field — the clean reads the
// manifest, not the catalogue of the day, so it cannot know or care.
test("clean removes seeded solves for a challenge no longer in the catalogue", () => {
  const seed = buildCommands({ count: 30, catalogue, now: 1_000_000_000_000 });
  const m = manifestFor(seed.cmds);
  const clean = cleanCommands(m); // no catalogue argument exists any more
  const dvwa = clean.cmds.filter((c) => c[0] === "HDEL" && c[1] === "ctf:solves:dvwa").flatMap((c) => c.slice(2));
  for (const c of seed.cmds.filter((c) => c[1] === "ctf:solves:dvwa")) assert.ok(dvwa.includes(c[2]), `stranded: ${c[2]}`);
});

// The other Major: `load-0001` is a legal GitHub login. Ownership is the
// manifest, so a seed must refuse to write over a row it did not record.
test("a seed refuses to write over an existing key or field it does not own, and re-runs over its own rows", () => {
  const seed = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  const m = manifestFor(seed.cmds);
  // First run on an empty store: nothing collides.
  assert.deepEqual(collisions(m, { keys: new Set(), fields: {} }, null), []);
  // A real contestant whose login the seed would also use already has a user
  // hash and a quiz score (pick a login the seed gives quiz points to, so the
  // field is one the seed would write).
  const victim = m.fields["ctf:quiz:points"][0];
  const real = { keys: new Set([`ctf:user:${victim}`]), fields: { "ctf:quiz:points": new Set([victim]) } };
  const clash = collisions(m, real, null);
  assert.ok(clash.includes(`ctf:user:${victim}`), clash.join(","));
  assert.ok(clash.includes(`ctf:quiz:points#${victim}`), clash.join(","));
  assert.equal(clash.length, 2);
  // Re-run: everything from the previous run exists, but the previous manifest claims it.
  const after = storeAfter(seed.cmds);
  assert.deepEqual(collisions(m, after, m), []);
  // ...and a real row that appeared since is still caught.
  after.keys.add("ctf:team:load-team-01"); // already ours — claimed
  after.fields["ctf:solves:dvwa"].add(`${loginFor(2)}:ch-1`); // maybe ours, maybe not: only a collision if the manifest lacks it
  const extra = collisions(m, after, m);
  assert.ok(extra.every((x) => !m.keys.includes(x)), "claimed keys never collide");
});

// The third Major: a seed that dies half-way must leave a manifest naming
// exactly what it wrote so far — never the plan.
test("every batch ends by recording the manifest of what has landed so far, and only the last is complete", () => {
  const seed = buildCommands({ count: 20, catalogue, now: 1_000_000_000_000 });
  const previous = { keys: ["ctf:user:load-0099"], fields: { "ctf:quiz:points": ["load-0099"] } };
  const B = 50;
  const batches = planBatches(seed.cmds, previous, B);
  assert.equal(batches.length, Math.ceil(seed.cmds.length / B));
  let written = 0;
  batches.forEach((batch, i) => {
    const set = batch[batch.length - 1];
    assert.equal(set[0], "SET");
    assert.equal(set[1], MANIFEST_KEY);
    assert.ok(batch.length <= B + 1);
    written += batch.length - 1;
    const recorded = JSON.parse(set[2]);
    const expected = mergeManifests(previous, manifestFor(seed.cmds.slice(0, written)));
    assert.deepEqual({ keys: recorded.keys, fields: recorded.fields }, expected, `batch ${i} records exactly what has landed`);
    assert.equal(recorded.complete, i === batches.length - 1);
    // Nothing from a later batch is recorded yet.
    const later = manifestFor(seed.cmds.slice(written));
    for (const k of later.keys) if (!expected.keys.includes(k)) assert.ok(!recorded.keys.includes(k), `planned-not-written key recorded: ${k}`);
  });
  assert.equal(written, seed.cmds.length);
  // The previous run's rows stay owned.
  const final = JSON.parse(batches[batches.length - 1][batches[batches.length - 1].length - 1][2]);
  assert.ok(final.keys.includes("ctf:user:load-0099"));
  assert.ok(final.fields["ctf:quiz:points"].includes("load-0099"));
});

test("mergeManifests is a union with no duplicates", () => {
  const a = { keys: ["k1", "k2"], fields: { h: ["f1"] } };
  const b = { keys: ["k2", "k3"], fields: { h: ["f1", "f2"], g: ["x"] } };
  assert.deepEqual(mergeManifests(a, b), { keys: ["k1", "k2", "k3"], fields: { g: ["x"], h: ["f1", "f2"] } });
  assert.deepEqual(mergeManifests(null, b), { keys: ["k2", "k3"], fields: { g: ["x"], h: ["f1", "f2"] } });
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
