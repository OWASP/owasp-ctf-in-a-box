// The pure half of scripts/score-audit.mjs: the independent recompute over a
// small synthetic store with totals worked out by hand, the flight-payload
// parser (and that an unrecognised shape FAILS rather than passes), the diff,
// the read-only guard, and the one-hop redirect rule of the board fetch.
// Run: node --test scripts/test/score-audit.test.mjs (scripts/test/score-audit.bats runs it in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  assertRedisUrl,
  assertReadOnly,
  auditAttempt,
  audit,
  diffBoard,
  extractBoard,
  fetchFlight,
  fingerprint,
  hintsEnabled,
  liveModules,
  parseFlightRows,
  recompute,
} from "../score-audit.mjs";

const T = (min) => new Date(Date.UTC(2026, 8, 30, 10, min)).toISOString();
const row = (points, at) => JSON.stringify({ points, at });

// The store. Worked totals (ai is switched OFF; hints are on by default):
//   alice  SD c1=10 (+ an id the rubric lacks, ignored) + quiz 40      = 50 − 3 (spent as "Alice") = 47, 3 items
//   bob    SD c1+c2=30 + quiz 10                                        = 40 − 7                    = 33, 3 items
//   carol  SD c2+w1=25 + classic 100                                    = 125,                         3 items
//   erin   classic 50, frank classic 50 — a full tie (no SD activity)   → ranks 2–3 either way
// Ranks are points first (#522): erin and frank (50, 1 item) sit above alice
// (47, 3 items) and bob (33, 3 items), where the old items-first rule put
// them last.
//   dave   ai 500 only — ai is off, so no row at all
// Teams: red [alice, bob]: SD union {c1,c2}=30, quiz union {q1 (bob's, earlier), q2}=40 → 70 − (3+7) = 60
//        blue [carol] — carol MOVED here from red: all her solves, including
//        those made before the move, count for blue and none for red → 125
//        green [erin, frank]: the same classic k1 once → 50
export function snapshot() {
  return {
    settings: { enabledModules: "secure-development, quiz ,classic" },
    scoreImage: true,
    sdCatalogue: [
      { app: "dvwa", id: "c1", points: 10 },
      { app: "dvwa", id: "c2", points: 20 },
      { app: "webgoat", id: "w1", points: 5 },
    ],
    sdSolves: {
      dvwa: { "alice:c1": T(1), "alice:gone": T(2), "bob:c1": T(3), "bob:c2": T(4), "carol:c2": T(5) },
      webgoat: { "carol:w1": T(6) },
    },
    agg: {
      quiz: { points: { alice: "40", bob: "10" }, count: { alice: "2", bob: "1" } },
      classic: { points: { carol: "100", erin: "50", frank: "50" }, count: { carol: "1", erin: "1", frank: "1" } },
      ai: { points: { dave: "500" }, count: { dave: "1" } },
    },
    rows: {
      quiz: { alice: { q1: row(10, T(20)), q2: row(30, T(21)) }, bob: { q1: row(10, T(10)) }, carol: {}, erin: {}, frank: {}, dave: {} },
      classic: { alice: {}, bob: {}, carol: { k2: row(100, T(30)) }, erin: { k1: row(50, T(31)) }, frank: { k1: row(50, T(32)) }, dave: {} },
      ai: { alice: {}, bob: {}, carol: {}, erin: {}, frank: {}, dave: { a1: row(500, T(40)) } },
    },
    hintsSpent: { bob: "7", Alice: "3" },
    teams: [
      { slug: "red", name: "Red", members: ["alice", "bob"] },
      { slug: "blue", name: "$money", members: ["carol"] },
      { slug: "green", name: "Green", members: ["erin", "frank"] },
    ],
    users: { alice: "red", bob: "red", carol: "blue", erin: "green", frank: "green", dave: null },
  };
}

const sd = (points, completed) => ({ points, completed, lastActivityAt: null, detail: { kind: "secure-development", apps: "$REF" } });
const mod = (points, completed) => ({ points, completed, lastActivityAt: null, detail: { kind: "x" } });

/** The board a correct fold serves for snapshot(). */
export function correctBoard() {
  return {
    entries: [
      { rank: 1, login: "carol", team: "blue", points: 125, patched: 2, apps: {}, modules: { "secure-development": sd(25, 2), classic: mod(100, 1) } },
      { rank: 4, login: "alice", team: "red", points: 47, hintPenalty: 3, patched: 1, apps: {}, modules: { "secure-development": sd(10, 1), quiz: mod(40, 2) } },
      { rank: 5, login: "bob", team: "red", points: 33, hintPenalty: 7, patched: 2, apps: {}, modules: { "secure-development": sd(30, 2), quiz: mod(10, 1) } },
      { rank: 2, login: "frank", team: "green", points: 50, patched: 0, apps: {}, modules: { classic: mod(50, 1) } },
      { rank: 3, login: "erin", team: "green", points: 50, patched: 0, apps: {}, modules: { classic: mod(50, 1) } },
    ],
    teams: [
      { rank: 1, slug: "blue", name: "$money", captain: "carol", members: ["carol"], points: 125, modules: { "secure-development": mod(25, 2), classic: mod(100, 1) } },
      { rank: 2, slug: "red", name: "Red", captain: "alice", members: ["alice", "bob"], points: 60, hintPenalty: 10, modules: { "secure-development": mod(30, 2), quiz: mod(40, 2) } },
      { rank: 3, slug: "green", name: "Green", captain: "erin", members: ["erin", "frank"], points: 50, modules: { classic: mod(50, 1) } },
    ],
    generatedAt: T(50),
    capabilities: { apps: true, teams: true, challenges: true },
    completable: 5,
  };
}

/**
 * Serializes `data` the way React's flight stream does on this page: the
 * <Leaderboard> props inside an element tuple ["$", type, key, props], `$`
 * strings escaped as `$$`, undefined as "$undefined", the SD block's `apps`
 * as a PATH reference back into the same row (the dedupe React emits for an
 * object seen twice), and unrelated I / text rows around it.
 */
export function toFlight(data) {
  const esc = (v) => {
    if (typeof v === "string") return v.startsWith("$") ? `$${v}` : v;
    if (v === undefined) return "$undefined";
    if (Array.isArray(v)) return v.map(esc);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, esc(x)]));
    return v;
  };
  const d = esc(data);
  d.entries.forEach((e, i) => {
    const b = e.modules && e.modules["secure-development"];
    if (b && b.detail) b.detail.apps = `$a:props:children:1:props:data:entries:${i}:apps`;
  });
  const tree = ["$", "div", null, { className: "flex", children: [["$", "p", null, { children: "Standings" }], ["$", "$L4", null, { data: d, viewerLogin: null, modules: [], enabledApps: "$undefined" }]] }];
  const text = "multi\nline ✓ text";
  return [
    '1:"$Sreact.fragment"',
    '4:I[65654,["/_next/static/chunks/x.js"],"default"]',
    ':HL["/_next/static/chunks/x.css","style"]',
    `b:T${Buffer.byteLength(text, "utf8").toString(16)},${text}a:${JSON.stringify(tree)}`,
    "c:C",
    "",
  ].join("\n");
}

test("the recompute matches the hand-worked totals", () => {
  const exp = recompute(snapshot());
  assert.deepEqual(exp.live, ["classic", "quiz", "secure-development"]);
  const e = (l) => exp.entries.get(l);
  assert.equal(e("alice").points, 47);
  assert.equal(e("alice").penalty, 3, "a case-variant spend field lands on the same login");
  assert.equal(e("bob").points, 33);
  assert.equal(e("carol").points, 125);
  assert.equal(exp.entries.has("dave"), false, "a disabled module creates no row");
  assert.deepEqual(e("alice").modules, { "secure-development": { points: 10, completed: 1 }, quiz: { points: 40, completed: 2 } });
  const t = (s) => exp.teams.get(s);
  assert.equal(t("red").points, 60);
  assert.equal(t("red").penalty, 10, "a team's penalty is the sum of its members'");
  assert.deepEqual(t("red").modules, { "secure-development": { points: 30, completed: 2 }, quiz: { points: 40, completed: 2 } });
  assert.equal(t("blue").points, 125, "a member who changed teams takes every solve to the new team");
  assert.equal(t("green").points, 50, "an item two members hold counts once");
  assert.deepEqual(e("carol").rankRange, [1, 1]);
  assert.deepEqual(e("erin").rankRange, [2, 3], "points outrank items (#522)");
  assert.deepEqual(e("frank").rankRange, [2, 3], "points outrank items (#522)");
  assert.deepEqual(e("alice").rankRange, [4, 4]);
  assert.deepEqual(e("bob").rankRange, [5, 5]);
  assert.deepEqual(exp.invariants, []);
  assert.equal(exp.stats.sdSolvesCounted, 5);
  assert.equal(exp.stats.sdSolvesIgnored, 1);
});

test("a correct board audits clean and non-vacuous", () => {
  const r = audit(snapshot(), toFlight(correctBoard()));
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.vacuous, false);
  assert.equal(r.counts.comparedContestants, 5);
  assert.equal(r.counts.comparedTeams, 3);
});

test("a full tie accepts either order", () => {
  const b = correctBoard();
  b.entries[3].rank = 3;
  b.entries[4].rank = 2;
  assert.deepEqual(audit(snapshot(), toFlight(b)).mismatches, []);
});

test("a team whose app-side module points were added twice is a finding", () => {
  const b = correctBoard();
  b.teams[1].points = 60 + 40; // quiz counted a second time; the block still says 40
  const r = audit(snapshot(), toFlight(b));
  assert.equal(r.mismatches.length, 1);
  assert.deepEqual(r.mismatches[0], { who: "team red", field: "points (net)", expected: 60, served: 100 });
});

test("a moved member's points left behind on the old team are a finding", () => {
  const b = correctBoard();
  b.teams[1].members = ["alice", "bob", "carol"];
  const r = audit(snapshot(), toFlight(b));
  assert.ok(r.mismatches.some((m) => m.who === "team red" && m.field === "members"));
});

test("team members that differ from the store only in case are not a finding", () => {
  const b = correctBoard();
  b.teams[1].members = ["Bob", "alice"]; // sorted by raw string, "Bob" lands first
  assert.deepEqual(audit(snapshot(), toFlight(b)).mismatches, []);
});

test("a hint penalty the board forgot, a wrong module block, a rank out of place, a missing and an extra row are each findings", () => {
  const b = correctBoard();
  b.entries[2].points = 40;
  delete b.entries[2].hintPenalty;
  b.entries[0].modules.classic = mod(90, 1);
  b.entries[3].rank = 1;
  b.entries[0].rank = 4;
  b.entries.push({ rank: 6, login: "dave", team: null, points: 500, patched: 0, apps: {}, modules: { ai: mod(500, 1) } });
  b.teams.pop();
  const fields = audit(snapshot(), toFlight(b)).mismatches.map((m) => `${m.who}/${m.module ?? ""}/${m.field}`);
  for (const want of ["contestant bob//points (net)", "contestant bob//hint penalty", "contestant carol/classic/points", "contestant frank//rank", "contestant dave//row", "team green//row"]) {
    assert.ok(fields.includes(want), `expected a finding ${want}; got ${fields.join(", ")}`);
  }
});

test("a board that shows nothing while the store has data fails, and says it compared nothing", () => {
  const b = correctBoard();
  b.entries = [];
  b.teams = [];
  const r = audit(snapshot(), toFlight(b));
  assert.equal(r.vacuous, true);
  assert.ok(r.mismatches.length >= 8);
});

test("an empty store is vacuous too, never a pass", () => {
  const s = { settings: {}, scoreImage: false, sdCatalogue: null, sdSolves: {}, agg: {}, rows: {}, hintsSpent: {}, teams: [], users: {} };
  const b = correctBoard();
  b.entries = [];
  b.teams = [];
  const r = audit(s, toFlight(b));
  assert.equal(r.vacuous, true);
  assert.equal(r.storeEmpty, true);
});

test("an unexpected payload shape FAILS rather than passes", () => {
  // Not a flight stream at all (e.g. the HTML page).
  assert.throws(() => audit(snapshot(), "<!DOCTYPE html><html></html>"), /flight/);
  // A flight stream with no board props in it.
  assert.throws(() => audit(snapshot(), '0:["$","div",null,{"children":"hi"}]\n'), /no <Leaderboard> props/);
  // Board props with an entry missing its points.
  const b = correctBoard();
  delete b.entries[1].points;
  assert.throws(() => audit(snapshot(), toFlight(b)), /entries\[1\]\.points/);
  // A module the auditor does not know.
  const c = correctBoard();
  c.teams[0].modules.bingo = mod(1, 1);
  assert.throws(() => audit(snapshot(), toFlight(c)), /not a known module/);
  // A reference form it does not know (a Map, "$Q…") inside the data.
  const f = toFlight(correctBoard()).replace('"generatedAt":"', '"series":"$Q1f","generatedAt":"');
  assert.throws(() => audit(snapshot(), f), /unsupported reference/);
  // Two objects that both look like the board: ambiguous.
  const flight = toFlight(correctBoard());
  const treeRow = flight.slice(flight.indexOf("a:[") + 2).split("\n")[0];
  const twice = `${flight}d:${treeRow}\n`;
  assert.throws(() => audit(snapshot(), twice), /ambiguous/);
});

test("the parser resolves escapes, path references and byte-sized text rows", () => {
  const board = extractBoard(toFlight(correctBoard()));
  assert.equal(board.teams[0].name, "$money", "a `$$` escape decodes to one `$`");
  const rows = parseFlightRows(toFlight(correctBoard()));
  assert.equal(rows.get("b").value, "multi\nline ✓ text");
  assert.equal(rows.get("a").tag, "J");
});

test("store invariants: an aggregate that disagrees with its rows, a login on two teams, a stale user record", () => {
  const s = snapshot();
  s.agg.quiz.points.alice = "45";
  s.teams[2].members = ["erin", "frank", "carol"];
  s.users.bob = "blue";
  const kinds = recompute(s).invariants.map((f) => `${f.kind}:${f.login}`);
  assert.ok(kinds.includes("aggregate-vs-rows:alice"));
  assert.ok(kinds.includes("login-on-several-teams:carol"));
  assert.ok(kinds.includes("user-team-field:bob"));
});

test("module decoding follows admin-store: comma list, empty = none, unknown-only = default, no SCORE_IMAGE drops SD", () => {
  assert.deepEqual([...liveModules({}, true)], ["secure-development"]);
  assert.deepEqual([...liveModules({}, false)], []);
  assert.deepEqual([...liveModules({ enabledModules: "" }, true)], []);
  assert.deepEqual([...liveModules({ enabledModules: "bogus" }, true)], ["secure-development"]);
  assert.deepEqual([...liveModules({ enabledModules: "quiz,secure-development" }, false)], ["quiz"]);
  assert.equal(hintsEnabled({}), true);
  assert.equal(hintsEnabled({ hintsEnabled: "1" }), true);
  assert.equal(hintsEnabled({ hintsEnabled: "0" }), false);
});

test("hints switched off forgive the penalty on the board (the spend stays stored)", () => {
  const s = snapshot();
  s.settings.hintsEnabled = "0";
  const exp = recompute(s);
  assert.equal(exp.entries.get("bob").points, 40);
  assert.equal(exp.teams.get("red").points, 70);
});

test("secure-development off: no SD points anywhere, module rows remain", () => {
  const s = snapshot();
  s.settings.enabledModules = "quiz,classic";
  const exp = recompute(s);
  assert.equal(exp.entries.get("carol").points, 100);
  assert.equal(exp.teams.get("red").points, 30);
});

// The token rides in the Authorization header, so a guard that let plain
// http:// through to a public host would send it in cleartext. The public
// IPv6 cases carry private-looking groups mid-address: they pass only if the
// prefix checks lose their `^` anchor.
test("the Redis URL guard allows https and private http endpoints only", () => {
  for (const ok of ["https://redis.example.com", "http://srh", "http://localhost:8079", "http://127.0.0.1", "http://app.internal", "http://[::1]:80", "http://[fdaa::3]", "http://[fc00::1]", "http://[fe80::1]"]) {
    assert.doesNotThrow(() => assertRedisUrl(ok), ok);
  }
  for (const bad of ["http://redis.example.com", "http://srh.example.com", "http://internal.example.com", "http://127.0.0.1.nip.io", "http://[2001:db8::1]", "http://[2606:4700:fe80::1]", "http://[2606:4700:fc00::1]", "ftp://srh", "not a url"]) {
    assert.throws(() => assertRedisUrl(bad), /UPSTASH_REDIS_REST_URL/, bad);
  }
});

test("the read-only guard refuses every write before it is sent", () => {
  assert.doesNotThrow(() => assertReadOnly([["HGETALL", "k"], ["scan", "0", "MATCH", "x"], ["SMEMBERS", "s"]]));
  for (const c of [["HSET", "k", "f", "v"], ["DEL", "k"], ["EVAL", "return 1", "0"], ["SET", "k", "v"], ["FLUSHALL"], ["HINCRBY", "k", "f", "1"]]) {
    assert.throws(() => assertReadOnly([["GET", "k"], c]), /non-read-only/);
  }
  assert.throws(() => assertReadOnly([]), /non-empty/);
  assert.throws(() => assertReadOnly([[42]]), /non-read-only/);
});

test("the fingerprint notices any change in the store", () => {
  const a = snapshot();
  const b = snapshot();
  assert.equal(fingerprint(a), fingerprint(b));
  b.sdSolves.dvwa["alice:c2"] = T(9);
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test("the board fetch follows the _rsc cache-bust hop and refuses the pre-launch redirect", async () => {
  const flight = toFlight(correctBoard());
  let lock = false;
  const server = createServer((req, res) => {
    if (req.headers.rsc !== "1") { res.writeHead(400).end(); return; }
    if (lock) { res.writeHead(307, { location: "/" }).end(); return; }
    if (req.url === "/leaderboard") { res.writeHead(307, { location: "/leaderboard?_rsc" }).end(); return; }
    if (req.url === "/leaderboard?_rsc") { res.writeHead(200, { "content-type": "text/x-component" }).end(flight); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await fetchFlight(base), flight);
    lock = true;
    await assert.rejects(fetchFlight(base), /redirected to \/ .*pre-launch/);
  } finally {
    server.close();
  }
});

test("diffBoard flags a broken rank sequence even when every row's own range holds", () => {
  const exp = recompute(snapshot());
  const served = extractBoard(toFlight(correctBoard()));
  served.entries[4].rank = 2; // erin and frank both 2: each inside its tie range, but the sequence is 1,2,2,4,5
  const { mismatches } = diffBoard(exp, served);
  assert.ok(mismatches.some((m) => m.field === "rank sequence"));
});

test("one attempt lets the SD fetch cache go stale BEFORE priming, then waits past the fold memo before the compared fetch", async () => {
  const log = [];
  const snap = snapshot();
  const flight = toFlight(correctBoard());
  const r = await auditAttempt({
    readSnapshot: async () => { log.push("read"); return snap; },
    fetchFlight: async () => { log.push("fetch"); return flight; },
    sleep: async (ms) => { log.push(`sleep ${ms}`); },
    sdCacheMs: 31000,
    memoMs: 11000,
  });
  assert.deepEqual(log, ["read", "sleep 31000", "fetch", "sleep 11000", "fetch", "read"]);
  assert.equal(r.stable, true);
  assert.equal(r.flight, flight);
  assert.equal(r.snapshot, snap);
});

test("without Secure Development live the SD-cache wait is skipped", async () => {
  const log = [];
  const snap = snapshot();
  snap.settings.enabledModules = "quiz,classic";
  await auditAttempt({
    readSnapshot: async () => { log.push("read"); return snap; },
    fetchFlight: async () => { log.push("fetch"); return ""; },
    sleep: async (ms) => { log.push(`sleep ${ms}`); },
    sdCacheMs: 31000,
    memoMs: 11000,
  });
  assert.deepEqual(log, ["read", "fetch", "sleep 11000", "fetch", "read"]);
});

test("a store that moves between the two reads makes the attempt unstable", async () => {
  let n = 0;
  const r = await auditAttempt({
    readSnapshot: async () => { const s = snapshot(); if (n++ > 0) s.hintsSpent.bob = "8"; return s; },
    fetchFlight: async () => "",
    sleep: async () => {},
    sdCacheMs: 0,
    memoMs: 0,
  });
  assert.equal(r.stable, false);
});
