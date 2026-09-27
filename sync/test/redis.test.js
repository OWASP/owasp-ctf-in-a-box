import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeRedis, outsideScoringWindow, outsideWindow } from "../src/redis.js";
import { TARGETS } from "../src/config.js";

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const env = { UPSTASH_REDIS_REST_URL: "http://srh:80", UPSTASH_REDIS_REST_TOKEN: "t" };

// Mock fetch that returns a single HMGET [paused, scoringStartsAt, scoringEndsAt] reply.
const hmgetFetch = (row) => async () =>
  new Response(JSON.stringify([{ result: row }]), { status: 200 });

test("outsideWindow: before start / after end / inside / unbounded", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  assert.equal(outsideWindow(now, FUTURE, null), true);
  assert.equal(outsideWindow(now, null, PAST), true);
  assert.equal(outsideWindow(now, PAST, FUTURE), false);
  assert.equal(outsideWindow(now, null, null), false);
});

// Shared differential corpus (issue #232): same cases run verbatim against
// apps/web's schedule-window.ts and scorer/src/store.js, so a <-><= flip
// surviving this suite's own hand-written cases still fails wherever the
// corpus DOES catch it, and vice versa — the three readers can't drift apart
// on the exact boundary instant without CI noticing.
test("outsideWindow: shared boundary-instant corpus", async (t) => {
  const url = new URL("../../test/fixtures/window-corpus.json", import.meta.url);
  const { cases } = JSON.parse(await readFile(url, "utf8"));
  for (const { description, nowMs, startsAt, endsAt, expected } of cases) {
    await t.test(description, () => {
      assert.equal(outsideWindow(nowMs, startsAt, endsAt), expected);
    });
  }
});

// The scoring window's own corpus (#464): a start is REQUIRED — an absent or
// unparseable scoringStartsAt means the event has not launched. Same rows run
// against apps/web's schedule-window.ts and scorer/src/store.js.
test("outsideScoringWindow: shared scoring-window corpus (#464)", async (t) => {
  const url = new URL("../../test/fixtures/scoring-window-corpus.json", import.meta.url);
  const { cases } = JSON.parse(await readFile(url, "utf8"));
  for (const { description, nowMs, startsAt, endsAt, expected } of cases) {
    await t.test(description, () => {
      assert.equal(outsideScoringWindow(nowMs, startsAt, endsAt), expected);
    });
  }
});

test("isPaused: no scoringStartsAt means not launched, so paused (#464)", async () => {
  const redis = makeRedis(env, hmgetFetch([null, null, null]));
  assert.equal(await redis.isPaused(), true);
});

test("isPaused: manual flag pauses", async () => {
  const redis = makeRedis(env, hmgetFetch(["1", null, null]));
  assert.equal(await redis.isPaused(), true);
});

test("isPaused: scheduled window (after end) pauses without the manual flag", async () => {
  const redis = makeRedis(env, hmgetFetch([null, null, PAST]));
  assert.equal(await redis.isPaused(), true);
});

test("isPaused: inside the window is not paused", async () => {
  const redis = makeRedis(env, hmgetFetch([null, PAST, FUTURE]));
  assert.equal(await redis.isPaused(), false);
});

test("isPaused: fails OPEN when redis errors", async () => {
  const redis = makeRedis(env, async () => { throw new Error("down"); }, () => {});
  assert.equal(await redis.isPaused(), false);
});

// A per-command failure comes back as { error } with a 200 — the shape a
// WRONGTYPE, NOAUTH or unknown-command reply from SRH takes. It must be
// treated like any other read failure: fail OPEN, and say so.
const errorReplyFetch = (message) => async () =>
  new Response(JSON.stringify([{ error: message }]), { status: 200 });

test("isPaused: a per-command error reply fails OPEN and is logged", async () => {
  const logs = [];
  const redis = makeRedis(env, errorReplyFetch("WRONGTYPE Operation against a key holding the wrong kind of value"), (m) => logs.push(m));
  assert.equal(await redis.isPaused(), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /isPaused.*WRONGTYPE/);
});

test("getResetAt: a per-command error reply reads as no reset and is logged", async () => {
  const logs = [];
  const redis = makeRedis(env, errorReplyFetch("NOAUTH Authentication required"), (m) => logs.push(m));
  assert.equal(await redis.getResetAt(), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /getResetAt.*NOAUTH/);
});

test("writeStatus: a per-command error reply is logged instead of vanishing", async () => {
  const logs = [];
  const redis = makeRedis(env, errorReplyFetch("WRONGTYPE Operation against a key holding the wrong kind of value"), (m) => logs.push(m));
  await redis.writeStatus({ lastPollAt: PAST, ingested: 1, reposPolled: 1, paused: false });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /writeStatus.*WRONGTYPE/);
});

// A backend that accepts the connection and never answers must not stall the
// tick forever — `restart: on-failure` cannot help a process that never exits.
/** A fake fetch that settles only when its signal aborts. The ref'd timer does
 *  two jobs: it keeps the event loop alive (a real fetch holds a socket, but
 *  `AbortSignal.timeout`'s own timer is unref'd, so without it Node 22 drains
 *  the loop before the timeout fires and the test dies as "promise still
 *  pending"), and it fails the test fast if the abort never arrives. */
const hangUntilAborted = (_url, { signal }) =>
  new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const giveUp = setTimeout(() => reject(new Error("fake backend: abort never arrived")), 5_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(giveUp);
        reject(signal.reason);
      },
      { once: true },
    );
  });

test("isPaused: a hung backend times out and fails OPEN", async () => {
  const logs = [];
  const redis = makeRedis(env, hangUntilAborted, (m) => logs.push(m), { timeoutMs: 20 });
  assert.equal(await redis.isPaused(), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /isPaused.*timeout/i);
});

// Redis's unknown-command error echoes the command's arguments ("…, with args
// beginning with: …"). Those arguments are whatever the caller sent — for the
// app that could be a flag — so the echoed tail must never reach a log.
test("a per-command error is logged by its Redis error text, never its echoed arguments", async () => {
  const logs = [];
  const redis = makeRedis(
    env,
    errorReplyFetch("ERR unknown command 'hset', with args beginning with: 'ctf:sync:status' 'ctf{leaked}' "),
    (m) => logs.push(m),
  );
  assert.equal(await redis.isPaused(), false);
  assert.match(logs[0], /ERR unknown command 'hset'/);
  assert.doesNotMatch(logs[0], /ctf\{leaked\}/);
  assert.doesNotMatch(logs[0], /with args beginning with/);
});

// The cap is the other half of the log-hygiene rule: an error reply of
// arbitrary length must not become an arbitrarily long log line.
test("a per-command error longer than 200 characters is capped in the log", async () => {
  const logs = [];
  const redis = makeRedis(env, errorReplyFetch(`ERR ${"x".repeat(1000)}`), (m) => logs.push(m));
  assert.equal(await redis.isPaused(), false);
  const sanitized = logs[0].replace(/^redis isPaused: upstash: /, "");
  assert.equal(sanitized.length, 200);
  assert.match(sanitized, /^ERR x+$/);
});

// ── getSecureDevTargets: the admin panel's secure-development target
// selection, read fresh every tick ──────────────────────────────────────────
//
// Unlike isPaused/getResetAt above, this method must NOT fail open (or to any
// other silently-wrong default) — a poller that cannot read the override must
// not guess which subset to poll. So every failure mode here THROWS, and the
// only assertion about "logs" is that there ISN'T one — this method never
// calls `log` itself; the caller (tick) decides what to do with the throw.
const hgetFetch = (result) => async () => new Response(JSON.stringify([{ result }]), { status: 200 });

test("getSecureDevTargets: absent field polls all six", async () => {
  const redis = makeRedis(env, hgetFetch(null));
  assert.deepEqual(await redis.getSecureDevTargets(), TARGETS);
});

test("getSecureDevTargets: an empty string is absent, not an empty selection", async () => {
  const redis = makeRedis(env, hgetFetch(""));
  assert.deepEqual(await redis.getSecureDevTargets(), TARGETS);
});

test("getSecureDevTargets: a stored subset is returned in catalogue order, deduped", async () => {
  const redis = makeRedis(env, hgetFetch(JSON.stringify(["vampi", "vampi", "dvwa"])));
  assert.deepEqual(await redis.getSecureDevTargets(), ["dvwa", "vampi"]);
});

test("getSecureDevTargets: unknown ids are dropped, known ones kept", async () => {
  const redis = makeRedis(env, hgetFetch(JSON.stringify(["vampi", "not-a-real-target"])));
  assert.deepEqual(await redis.getSecureDevTargets(), ["vampi"]);
});

// CodeRabbit round 1 (issue #386 PR 3): a stored list that normalizes to NO
// known target id used to fall back to "all six," silently widening scope
// back open — the same wrong-default this whole method exists to refuse for
// every other unreadable/invalid case. `[]` and an all-unknown list must
// both throw instead, so `tick()`'s existing fail-closed path (poll nothing,
// log why) is what actually runs.
test("getSecureDevTargets: every stored id unknown throws instead of falling back to all six", async () => {
  const redis = makeRedis(env, hgetFetch(JSON.stringify(["nope", "still-nope"])));
  await assert.rejects(() => redis.getSecureDevTargets(), /secureDevTargets/);
});

test("getSecureDevTargets: an empty array (present but nothing selected) throws, distinct from an absent field", async () => {
  const redis = makeRedis(env, hgetFetch(JSON.stringify([])));
  await assert.rejects(() => redis.getSecureDevTargets(), /secureDevTargets/);
});

test("getSecureDevTargets: malformed JSON throws instead of silently defaulting", async () => {
  const redis = makeRedis(env, hgetFetch("{not json"));
  await assert.rejects(() => redis.getSecureDevTargets(), /secureDevTargets/);
});

test("getSecureDevTargets: a non-array JSON value throws", async () => {
  const redis = makeRedis(env, hgetFetch(JSON.stringify({ vampi: true })));
  await assert.rejects(() => redis.getSecureDevTargets(), /secureDevTargets/);
});

test("getSecureDevTargets: a transport error throws instead of failing open to all six", async () => {
  const redis = makeRedis(env, async () => { throw new Error("network down"); });
  await assert.rejects(() => redis.getSecureDevTargets(), /network down/);
});

test("getSecureDevTargets: a per-command error reply throws, unlike isPaused/getResetAt", async () => {
  const redis = makeRedis(env, errorReplyFetch("WRONGTYPE Operation against a key holding the wrong kind of value"));
  await assert.rejects(() => redis.getSecureDevTargets(), /WRONGTYPE/);
});
