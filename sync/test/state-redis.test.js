// ADR 64: the poller's durable state (cursor, seen-cache, counters, reset epoch)
// lives in Redis at `ctf:sync:state`, next to the scores it describes — not
// only on the task's disk, which Fargate (and any container restarted without
// its volume) throws away. These tests drive the REAL `makeRedis` client
// against an in-process fake of srh's /pipeline endpoint, so the wire shape,
// the per-command error handling and the key name are all the production
// code's, not a hand-rolled stand-in's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, tick } from "../src/index.js";
import { makeRedis, SYNC_STATE_KEY } from "../src/redis.js";
import { loadState, saveState } from "../src/state.js";

const env = { UPSTASH_REDIS_REST_URL: "http://srh:80", UPSTASH_REDIS_REST_TOKEN: "t" };
const STOP = new Error("stop-the-poll-loop");
const LAUNCHED = "2000-01-01T00:00:00.000Z";

/** A minimal Redis behind srh's /pipeline wire protocol: strings and hashes,
 *  the handful of commands sync sends. `failNext` makes the next N pipelines
 *  fail at the transport (a down srh); `errorOn` returns a per-command error
 *  reply for a given command name, inside a 200 (a NOAUTH/WRONGTYPE). */
function fakeSrh({ settings = { scoringStartsAt: LAUNCHED, secureDevTargets: '["vampi"]' } } = {}) {
  const strings = new Map();
  const hashes = new Map([["ctf:admin:settings", new Map(Object.entries(settings))]]);
  const srh = { strings, hashes, failNext: 0, errorOn: null, pipelines: [] };
  const hash = (k) => {
    if (!hashes.has(k)) hashes.set(k, new Map());
    return hashes.get(k);
  };
  const run = ([cmd, key, ...args]) => {
    switch (cmd) {
      case "GET":
        return strings.get(key) ?? null;
      case "SET":
        strings.set(key, args[0]);
        return "OK";
      case "HGET":
        return hashes.get(key)?.get(args[0]) ?? null;
      case "HMGET":
        return args.map((f) => hashes.get(key)?.get(f) ?? null);
      case "HSET":
        for (let i = 0; i < args.length; i += 2) hash(key).set(args[i], args[i + 1]);
        return args.length / 2;
      case "HDEL":
        return args.filter((f) => hashes.get(key)?.delete(f)).length;
      default:
        throw new Error(`fake srh: unsupported ${cmd}`);
    }
  };
  srh.fetchImpl = async (_url, init) => {
    const cmds = JSON.parse(init.body);
    srh.pipelines.push(cmds);
    if (srh.failNext > 0) {
      srh.failNext--;
      throw new TypeError("fetch failed");
    }
    const out = cmds.map((c) => (srh.errorOn === c[0] ? { error: "NOAUTH Authentication required." } : { result: run(c) }));
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return srh;
}

/** One PR comment on one repo, as GitHub's /issues/comments returns it. */
const comment = (id, updatedAt, login = "alice") => ({
  id,
  updated_at: updatedAt,
  user: { login: "github-actions[bot]" },
  body: `<!-- ctf-score: ${JSON.stringify({ target: "vampi", pr: id, author: login, solved: ["api1"] })} -->`,
});

/** A GitHub + scorer stand-in for the VAmPI repo that honours `since` the way
 *  the real API does (inclusive), and counts every score POST it receives. */
function fakeWorld(comments) {
  const world = { posts: [], polls: [] };
  world.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/score")) {
      world.posts.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    if (!u.pathname.includes("/VAmPI/")) throw new Error(`unexpected poll of ${u.pathname}`);
    const since = u.searchParams.get("since");
    world.polls.push(since);
    const page = comments.filter((c) => !since || c.updated_at >= since);
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  };
  return world;
}

const cfgFor = (dir) => ({
  org: "o",
  apiUrl: "https://api.example",
  getToken: async () => "ghs_test",
  scorerUrl: "http://scorer:4000",
  scorerToken: "s",
  commentAuthor: "github-actions[bot]",
  pollIntervalMs: 1000,
  statePath: join(dir, "state.json"),
});

/** Runs main() for `ticks` iterations, then stops it via the sleep seam. The
 *  real tick() runs against `world`; the real Redis client against `srh`. */
async function runMain({ cfg, srh, world, ticks = 1, sleeps = [], logErr = [] }) {
  let n = 0;
  await assert.rejects(
    () =>
      main({
        load: () => cfg,
        log: () => {},
        logErr: (m) => logErr.push(m),
        makeRedisImpl: () => makeRedis(env, srh.fetchImpl, () => {}),
        runTick: (c, state, opts) => tick(c, state, { ...opts, fetchImpl: world.fetchImpl, log: () => {} }),
        sleep: async (ms) => {
          sleeps.push(ms);
          if (++n >= ticks) throw STOP;
        },
      }),
    (err) => err === STOP,
  );
  return { sleeps, logErr };
}

const tmp = () => mkdtempSync(join(tmpdir(), "ctf-sync-r5-"));
const stored = (srh) => JSON.parse(srh.strings.get(SYNC_STATE_KEY));

test("the durable state key is ctf:sync:state — separate from the ctf:sync:status heartbeat", () => {
  assert.equal(SYNC_STATE_KEY, "ctf:sync:state");
});

test("a restart with no disk resumes from the cursor stored in Redis and re-ingests nothing", async () => {
  const srh = fakeSrh();
  const comments = [comment(1, "2026-10-01T10:00:00Z"), comment(2, "2026-10-01T10:05:00Z")];
  const world = fakeWorld(comments);

  // First task: ingests both comments and persists the cursor to Redis.
  await runMain({ cfg: cfgFor(tmp()), srh, world });
  assert.equal(world.posts.length, 2, "first boot ingests both comments");
  assert.equal(stored(srh).repos.VAmPI.since, "2026-10-01T10:05:00Z");
  assert.equal(stored(srh).ingested, 2);

  // Second task on a FRESH disk (Fargate): nothing on the filesystem at all.
  const world2 = fakeWorld(comments);
  await runMain({ cfg: cfgFor(tmp()), srh, world: world2 });
  assert.deepEqual(world2.polls, ["2026-10-01T10:05:00Z"], "polled from the stored cursor, not from the beginning");
  assert.equal(world2.posts.length, 0, "a restart must not re-submit comments it already ingested");
});

test("a per-contestant reset survives a restart: the reset contestant's comments are not re-submitted", async () => {
  // The reset deletes the contestant's solves in Redis; the scorer's HSETNX
  // would happily re-write them from a re-submitted comment. What keeps the
  // reset standing across a restart is that the restarted poller does not
  // re-present the comments it has already consumed.
  const srh = fakeSrh();
  const comments = [comment(7, "2026-10-01T11:00:00Z", "mallory")];
  await runMain({ cfg: cfgFor(tmp()), srh, world: fakeWorld(comments) });

  // ... organizer resets mallory here (app-side, not sync's keys) ...
  const after = fakeWorld(comments);
  await runMain({ cfg: cfgFor(tmp()), srh, world: after });
  assert.deepEqual(after.posts.filter((p) => p.author === "mallory"), []);
});

test("the /admin counters survive a restart: ingested/dropped/lastDrop carry over and the heartbeat reports them", async () => {
  const srh = fakeSrh();
  const bad = { id: 9, updated_at: "2026-10-01T09:00:00Z", user: { login: "github-actions[bot]" }, body: '<!-- ctf-score: {"author":"eve"} -->' };
  const comments = [bad, comment(1, "2026-10-01T10:00:00Z")];
  await runMain({ cfg: cfgFor(tmp()), srh, world: fakeWorld(comments) });
  const before = stored(srh);
  assert.equal(before.ingested, 1);
  assert.equal(before.dropped, 1);

  await runMain({ cfg: cfgFor(tmp()), srh, world: fakeWorld(comments) });
  const status = srh.hashes.get("ctf:sync:status");
  assert.equal(status.get("ingested"), "1", "the restarted poller's heartbeat keeps the ingested count");
  assert.equal(status.get("dropped"), "1", "the only record of a dropped score must not reset to 0");
  assert.equal(status.get("lastDrop"), before.lastDrop);
});

test("an unreadable Redis at startup holds the poller: no tick, loud log, retry until readable, then resume from the stored cursor", async () => {
  const srh = fakeSrh();
  srh.strings.set(
    SYNC_STATE_KEY,
    JSON.stringify({ repos: { VAmPI: { since: "2026-10-01T10:05:00Z", etag: null, seen: ["2@2026-10-01T10:05:00Z"] } }, ingested: 2, dropped: 0 }),
  );
  srh.failNext = 2; // srh is down for the first two attempts
  const comments = [comment(1, "2026-10-01T10:00:00Z"), comment(2, "2026-10-01T10:05:00Z")];
  const world = fakeWorld(comments);

  const { sleeps, logErr } = await runMain({ cfg: cfgFor(tmp()), srh, world, ticks: 3 });

  // Two failed reads, each followed by a wait — and NO poll or submit during
  // them: starting from zero here would re-ingest every score comment.
  const holds = logErr.filter((m) => /ctf:sync:state/.test(m) && /not polling/.test(m));
  assert.equal(holds.length, 2, `expected two hold lines, got ${JSON.stringify(logErr)}`);
  assert.deepEqual(sleeps, [1000, 1000, sleeps[2]]);
  assert.deepEqual(world.polls, ["2026-10-01T10:05:00Z"], "once readable, it polls from the STORED cursor");
  assert.equal(world.posts.length, 0);
});

test("a per-command error reply on the state read (NOAUTH inside a 200) is a failed read, not an empty state", async () => {
  const srh = fakeSrh();
  srh.strings.set(SYNC_STATE_KEY, JSON.stringify({ repos: { VAmPI: { since: "2026-10-01T10:05:00Z", etag: null, seen: [] } } }));
  srh.errorOn = "GET";
  const world = fakeWorld([comment(1, "2026-10-01T10:00:00Z")]);
  let ticked = 0;
  let sleeps = 0;
  await assert.rejects(
    () =>
      main({
        load: () => cfgFor(tmp()),
        log: () => {},
        logErr: () => {},
        makeRedisImpl: () => makeRedis(env, srh.fetchImpl, () => {}),
        runTick: async () => {
          ticked++;
        },
        sleep: async () => {
          if (++sleeps >= 3) throw STOP;
        },
      }),
    (err) => err === STOP,
  );
  assert.equal(ticked, 0, "must not tick on an unreadable state, however the failure is reported");
  assert.equal(world.posts.length, 0);
});

test("upgrade: with no Redis state yet, an existing state.json seeds it once and is retired so it can never seed again", async () => {
  const dir = tmp();
  const cfg = cfgFor(dir);
  saveState(cfg.statePath, {
    repos: { VAmPI: { since: "2026-10-01T10:05:00Z", etag: null, seen: ["2@2026-10-01T10:05:00Z"] } },
    ingested: 5,
    dropped: 1,
    lastDrop: "old drop",
  });
  const srh = fakeSrh();
  const world = fakeWorld([comment(1, "2026-10-01T10:00:00Z"), comment(2, "2026-10-01T10:05:00Z")]);
  const { logErr } = await runMain({ cfg, srh, world });

  assert.deepEqual(world.polls, ["2026-10-01T10:05:00Z"], "the file's cursor carried over");
  assert.equal(world.posts.length, 0);
  assert.equal(stored(srh).ingested, 5);
  assert.equal(stored(srh).dropped, 1);
  assert.ok(logErr.some((m) => /migrat/i.test(m)), "the one-time migration is logged");
  assert.equal(existsSync(cfg.statePath), false, "the file no longer sits at STATE_PATH");
  assert.equal(existsSync(`${cfg.statePath}.migrated`), true, "kept aside for the operator, not deleted");
});

test("with Redis present the file is never written: the durable copy is the one next to the scores", async () => {
  const dir = tmp();
  const cfg = cfgFor(dir);
  const srh = fakeSrh();
  await runMain({ cfg, srh, world: fakeWorld([comment(1, "2026-10-01T10:00:00Z")]) });
  assert.equal(existsSync(cfg.statePath), false);
  assert.ok(srh.strings.has(SYNC_STATE_KEY));
});

test("a Redis wiped of everything (key absent, no file) starts fresh and re-ingests — reconstructing the leaderboard", async () => {
  // The cursor lives WITH the scores on purpose: if both are gone, re-reading
  // every comment is exactly the recovery poll mode promises.
  const srh = fakeSrh();
  const world = fakeWorld([comment(1, "2026-10-01T10:00:00Z")]);
  await runMain({ cfg: cfgFor(tmp()), srh, world });
  assert.deepEqual(world.polls, [null]);
  assert.equal(world.posts.length, 1);
});

test("a failed state write after a tick is logged and retried next tick; the loop keeps polling", async () => {
  const srh = fakeSrh();
  const comments = [comment(1, "2026-10-01T10:00:00Z")];
  const world = fakeWorld(comments);
  const logErr = [];
  let n = 0;
  let failSets = 1;
  const flaky = async (url, init) => {
    const cmds = JSON.parse(init.body);
    if (cmds.some((c) => c[0] === "SET" && c[1] === SYNC_STATE_KEY) && n >= 1 && failSets > 0) {
      failSets--;
      throw new TypeError("fetch failed");
    }
    return srh.fetchImpl(url, init);
  };
  await assert.rejects(
    () =>
      main({
        load: () => cfgFor(tmp()),
        log: () => {},
        logErr: (m) => logErr.push(m),
        makeRedisImpl: () => makeRedis(env, flaky, () => {}),
        runTick: (c, state, opts) => tick(c, state, { ...opts, fetchImpl: world.fetchImpl, log: () => {} }),
        sleep: async () => {
          n++;
          if (n >= 3) throw STOP;
        },
      }),
    (err) => err === STOP,
  );
  assert.ok(logErr.some((m) => /ctf:sync:state/.test(m) && /fetch failed/.test(m)), JSON.stringify(logErr));
  assert.equal(stored(srh).repos.VAmPI.since, "2026-10-01T10:00:00Z", "the next tick's write landed");
  assert.equal(world.posts.length, 1, "the in-memory state kept deduping while the write was failing");
});

test("an unusable stored value is repaired loudly, keeping what survives (same rule as the file, #63)", async () => {
  const srh = fakeSrh();
  srh.strings.set(SYNC_STATE_KEY, JSON.stringify({ ingested: 4, resetAt: "123" }));
  const world = fakeWorld([]);
  const { logErr } = await runMain({ cfg: cfgFor(tmp()), srh, world });
  assert.ok(logErr.some((m) => /ctf:sync:state/.test(m) && /repos/.test(m)), JSON.stringify(logErr));
  assert.equal(stored(srh).ingested, 4);
  assert.equal(stored(srh).resetAt, "123");
});

test("with no Redis client (a dev poller) the file is still the store", async () => {
  const dir = tmp();
  const cfg = cfgFor(dir);
  writeFileSync(cfg.statePath, JSON.stringify({ repos: {}, ingested: 3 }));
  let seenIngested;
  await assert.rejects(
    () =>
      main({
        load: () => cfg,
        log: () => {},
        logErr: () => {},
        makeRedisImpl: () => null,
        runTick: async (c, state) => {
          seenIngested = state.ingested;
          state.ingested = 4;
        },
        sleep: async () => {
          throw STOP;
        },
      }),
    (err) => err === STOP,
  );
  assert.equal(seenIngested, 3, "the file seeded the tick");
  assert.equal(loadState(cfg.statePath).ingested, 4);
});
