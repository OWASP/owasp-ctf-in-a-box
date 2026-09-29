import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, parseState, saveState, repoState, markSeen, seenKey } from "../src/state.js";

/** Writes `body` to a fresh state file and loads it, capturing warnings. */
function loadWritten(body) {
  const p = join(mkdtempSync(join(tmpdir(), "st-")), "state.json");
  writeFileSync(p, body);
  const warnings = [];
  const state = loadState(p, { log: (m) => warnings.push(m) });
  return { state, warnings };
}

test("loadState returns empty state for missing or corrupt file", () => {
  assert.deepEqual(loadState("/nonexistent/state.json"), { repos: {} });
});

// ── malformed state must reset, never crash-loop (issue #63) ─────────────────
//
// The file is JSON the poller wrote, but a partial write, a disk problem or a
// hand edit during a reset can leave it valid JSON and still wrong. `{}` parses
// fine, so the old `catch` never fired; `repoState` then dereferenced an absent
// `repos` and threw on EVERY tick. That reject escapes `tick`'s per-repo catch,
// reaches main's fatal handler, and exits 1 — which compose restarts, straight
// back into the same file. Ingestion stays down for the whole event.

test("a bare {} resets to an empty state instead of throwing later", () => {
  const { state, warnings } = loadWritten("{}");
  assert.deepEqual(state, { repos: {} });
  assert.equal(warnings.length, 1, "a silent repair is how this went unnoticed");
  assert.match(warnings[0], /state/i);
});

test("a non-object repos is replaced", () => {
  for (const body of ['{"repos":null}', '{"repos":"nope"}', '{"repos":[1,2]}', '{"repos":7}']) {
    const { state, warnings } = loadWritten(body);
    assert.deepEqual(state.repos, {}, `repos should be reset for ${body}`);
    assert.equal(warnings.length, 1, `should warn for ${body}`);
  }
});

test("a root that is not an object at all falls back to a whole fresh state", () => {
  for (const body of ["[1,2,3]", '"a string"', "42", "null"]) {
    const { state, warnings } = loadWritten(body);
    assert.deepEqual(state, { repos: {} }, `root should reset for ${body}`);
    assert.equal(warnings.length, 1, `should warn for ${body}`);
  }
});

test("repairing repos keeps the rest of a usable state", () => {
  // A repair must not throw away good data: re-zeroing `ingested` would
  // misreport the event's totals on the admin status card, and dropping
  // `resetAt` would make the next tick re-apply a master reset it already did.
  const { state } = loadWritten('{"ingested":12,"resetAt":"2026-08-20T00:00:00Z"}');
  assert.deepEqual(state.repos, {});
  assert.equal(state.ingested, 12);
  assert.equal(state.resetAt, "2026-08-20T00:00:00Z");
});

test("an unreadable file warns, but a merely absent one does not", () => {
  const { warnings } = loadWritten("{ not json");
  assert.equal(warnings.length, 1);

  // First boot has no state file. That is the normal path, not a fault — a
  // warning here would cry wolf on every fresh event.
  const quiet = [];
  loadState("/nonexistent/state.json", { log: (m) => quiet.push(m) });
  assert.deepEqual(quiet, []);
});

test("a healthy state loads unchanged and silently", () => {
  const good = { repos: { DVWA: { since: "t1", etag: "e", seen: [1, 2] } }, ingested: 3 };
  const { state, warnings } = loadWritten(JSON.stringify(good));
  assert.deepEqual(state, good);
  assert.deepEqual(warnings, []);
});

test("repoState repairs a partial or junk per-repo entry", () => {
  // Each of these reached `markSeen`, which does `rs.seen.includes(id)` — the
  // same class of crash one level down.
  for (const entry of [{}, { since: "t1" }, { seen: "not-an-array" }, 42, null, "x"]) {
    const state = { repos: { DVWA: entry } };
    const rs = repoState(state, "DVWA");
    assert.ok(Array.isArray(rs.seen), `seen should be an array for ${JSON.stringify(entry)}`);
    assert.equal(markSeen(rs, 1), true);
    assert.equal(markSeen(rs, 1), false);
  }
});

test("repoState keeps a partial entry's usable fields", () => {
  const state = { repos: { DVWA: { since: "t1" } } };
  const rs = repoState(state, "DVWA");
  assert.equal(rs.since, "t1", "a cursor that survived the damage must not be discarded");
  assert.equal(rs.etag, null);
  assert.deepEqual(rs.seen, []);
});

test("repoState tolerates a state whose repos went missing after load", () => {
  // tick() assigns `state.repos = {}` on a master reset, so the invariant is
  // re-established there — but repoState is exported and must not assume it.
  const state = {};
  const rs = repoState(state, "DVWA");
  assert.deepEqual(rs, { since: null, etag: null, seen: [] });
  rs.since = "t1";
  assert.equal(state.repos.DVWA.since, "t1", "the slot must be live, not a copy");
});

test("save/load round-trip creates directories", () => {
  const p = join(mkdtempSync(join(tmpdir(), "st-")), "deep", "state.json");
  const state = { repos: { DVWA: { since: "t1", etag: "e", seen: [1] } } };
  saveState(p, state);
  assert.deepEqual(loadState(p), state);
});

test("repoState initializes per-repo slot in place", () => {
  const state = { repos: {} };
  const rs = repoState(state, "DVWA");
  assert.deepEqual(rs, { since: null, etag: null, seen: [] });
  rs.since = "t1";
  assert.equal(state.repos.DVWA.since, "t1");
});

test("markSeen dedupes and caps at 500", () => {
  const rs = { since: null, etag: null, seen: [] };
  const at = "2026-08-13T11:00:00Z";
  assert.equal(markSeen(rs, 42, at), true);
  assert.equal(markSeen(rs, 42, at), false);
  for (let i = 0; i < 600; i++) markSeen(rs, i, at);
  assert.equal(rs.seen.length, 500);
  assert.equal(rs.seen.includes(seenKey(599, at)), true);
});

// THE bug this key exists for. The scoring workflow upserts one comment per
// target — a placeholder first, the result edited into the same comment — so
// dedupe on the id alone made a re-scored PR permanently unreachable: the
// placeholder burned the id, and the edit carrying the real score was skipped.
test("markSeen re-presents a comment that was EDITED after being seen", () => {
  const rs = { since: null, etag: null, seen: [] };
  assert.equal(markSeen(rs, 7, "2026-08-13T11:00:00Z"), true);
  assert.equal(markSeen(rs, 7, "2026-08-13T11:05:00Z"), true, "an edited comment must be handled again");
  assert.equal(markSeen(rs, 7, "2026-08-13T11:05:00Z"), false, "…but only once per revision");
});

// State written before this key existed holds bare ids. They cannot match a
// revision key, so upgrading re-presents each still-cursored comment exactly
// once — which is the repair, not a regression: it is what recovers the
// scores the id-only key dropped.
test("markSeen re-presents comments recorded by an older build as bare ids", () => {
  const rs = { since: null, etag: null, seen: [5364196433] };
  assert.equal(markSeen(rs, 5364196433, "2026-08-21T02:06:17Z"), true);
});

// #508 review: the state now lives in Redis, where a hand edit with redis-cli
// is one command away. A counter that is not a count ("x", -3, 1.5) would
// otherwise poison `ingested++` into string concatenation or report a
// negative total on /admin, and a non-string resetAt would never equal the
// settings' epoch, so the master reset would be re-applied every tick.
test("parseState repairs bad counters and a non-string resetAt, one field at a time", () => {
  const warnings = [];
  const state = parseState(
    JSON.stringify({ repos: { VAmPI: { since: "s", etag: null, seen: [] } }, ingested: "x", dropped: -3, resetAt: 5, lastDrop: "kept" }),
    "test",
    { log: (m) => warnings.push(m) },
  );
  assert.equal(state.ingested, 0);
  assert.equal(state.dropped, 0);
  assert.equal(state.resetAt, null);
  assert.equal(state.lastDrop, "kept");
  assert.deepEqual(Object.keys(state.repos), ["VAmPI"]);
  for (const f of ["ingested", "dropped", "resetAt"]) {
    assert.ok(warnings.some((m) => m.includes(f)), `repair of ${f} is logged: ${JSON.stringify(warnings)}`);
  }
});

test("parseState keeps valid counters and resetAt untouched and silent", () => {
  const warnings = [];
  const body = { repos: {}, ingested: 7, dropped: 0, resetAt: "2026-10-01T00:00:00.000Z" };
  const state = parseState(JSON.stringify(body), "test", { log: (m) => warnings.push(m) });
  assert.deepEqual(state, body);
  const unset = parseState(JSON.stringify({ repos: {}, resetAt: null }), "test", { log: (m) => warnings.push(m) });
  assert.equal(unset.resetAt, null);
  assert.equal(unset.ingested, undefined, "an absent counter stays absent (tick defaults it)");
  assert.deepEqual(warnings, []);
});

test("loadState with strict: a missing file is a fresh state, any other read error throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  assert.deepEqual(loadState(join(dir, "absent.json"), { log: () => {}, strict: true }), { repos: {} });
  assert.throws(() => loadState(dir, { log: () => {}, strict: true }), /EISDIR|illegal operation/);
  // Without strict (the no-Redis dev poller) it still starts fresh, loudly.
  const warnings = [];
  assert.deepEqual(loadState(dir, { log: (m) => warnings.push(m) }), { repos: {} });
  assert.equal(warnings.length, 1);
});
