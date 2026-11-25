// main()'s half of the config-v2 contract: sync no longer decides "am I
// enabled" — if the container runs, it polls. Whether sync runs at all is
// the compose profile's call, not a module key in a config file. So the only
// thing left for main() to guard against is a genuinely broken config (e.g.
// GITHUB_ORG unset): that must refuse loudly at startup, not crash-loop
// silently or fall through with a half-built cfg.
//
// Every collaborator is injected here, so these tests need no real env, no
// Redis, no GitHub, and — crucially — no way for the infinite poll loop to
// actually run away: `sleep` throws a sentinel to end the second iteration,
// and `exit` throws the same sentinel so a startup refusal doesn't actually
// kill the test process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/index.js";
import { IncompatibleRedisError } from "../src/redis.js";

const STOP = new Error("stop-the-poll-loop");

function spyDeps(overrides = {}) {
  const calls = { order: [], compatibility: 0, readState: 0, makeRedis: 0, tick: [], writeState: [], pollState: [], sleep: [], log: [], logErr: [], exit: [] };
  const deps = {
    log: (m) => calls.log.push(m),
    logErr: (m) => calls.logErr.push(m),
    readState: (p) => {
      calls.order.push("readState");
      calls.readState++;
      calls.statePath = p;
      return { repos: {} };
    },
    makeRedisImpl: () => {
      calls.makeRedis++;
      // No stored poll state yet (a first boot), so main() seeds it from
      // readState and writes it back before the first tick (ADR 64).
      return {
        fake: "redis",
        ensureCompatible: async () => {
          calls.order.push("ensureCompatible");
          calls.compatibility++;
        },
        readPollState: async () => null,
        writePollState: async (s) => calls.pollState.push(s),
      };
    },
    retireFile: () => false,
    runTick: async (cfg, state, opts) => {
      calls.tick.push({ cfg, state, opts });
      return state;
    },
    writeState: (p, s) => calls.writeState.push([p, s]),
    sleep: (ms) => {
      calls.sleep.push(ms);
      throw STOP; // one iteration is all we need to prove it entered the loop
    },
    exit: (code) => {
      calls.exit.push(code);
      throw STOP; // like sleep, unwinds main() without actually killing the test
    },
    onStop: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test("a config error at startup logs 'ctf-sync: <message>' and exits 1, before touching state/redis/the loop", async () => {
  const { deps, calls } = spyDeps({
    load: () => {
      throw new Error("GITHUB_ORG is not set");
    },
  });

  await assert.rejects(() => main(deps), (err) => err === STOP);

  assert.deepEqual(calls.logErr, ["ctf-sync: GITHUB_ORG is not set"]);
  assert.deepEqual(calls.exit, [1]);
  assert.equal(calls.readState, 0);
  assert.equal(calls.makeRedis, 0);
  assert.deepEqual(calls.tick, []);
  assert.deepEqual(calls.sleep, []);
  assert.deepEqual(calls.log, []);
});

test("a valid config proceeds: state, redis, then the poll loop", async () => {
  const cfg = {
    org: "test-event-org",
    statePath: "/state/state.json",
    pollIntervalMs: 30000,
  };
  const { deps, calls } = spyDeps({ load: () => cfg });

  await assert.rejects(() => main(deps), (err) => err === STOP);

  assert.equal(calls.compatibility, 1);
  assert.deepEqual(calls.order, ["ensureCompatible", "readState"]);
  assert.equal(calls.readState, 1);
  assert.equal(calls.statePath, "/state/state.json");
  assert.equal(calls.makeRedis, 1);
  assert.equal(calls.tick.length, 1);
  assert.equal(calls.tick[0].cfg, cfg);
  assert.equal(calls.tick[0].opts.redis.fake, "redis");
  // With Redis, the tick's state is persisted to Redis before sleeping (once
  // to establish the key, once after the tick) and the file is not written.
  assert.equal(calls.pollState.length, 2);
  assert.equal(calls.pollState[1], calls.tick[0].state);
  assert.deepEqual(calls.writeState, []);
  // Slept around the configured interval (±20% jitter), not the raw value.
  assert.equal(calls.sleep.length, 1);
  assert.ok(calls.sleep[0] >= 24000 && calls.sleep[0] <= 36000, `slept ${calls.sleep[0]}ms`);
  // The startup banner names the event, not a repo count — which targets get
  // polled is now a per-tick Redis read, so a count printed once at boot
  // would go stale the moment an organizer changes it in /admin. With a
  // (fake) Redis client present, the "no Redis client" warning must not fire.
  assert.match(calls.logErr[0], /polling test-event-org every 30000ms/);
  assert.equal(calls.logErr.length, 1);
  assert.deepEqual(calls.log, []);
  assert.deepEqual(calls.exit, []);
});

// Without Redis there is no link table to attribute a PR author to a player,
// so the poller refuses to start rather than drop every score.
test("refuses to start without a Redis client", async () => {
  const cfg = { org: "o", statePath: "/s", pollIntervalMs: 1000 };
  const logErrLines = [];
  const exits = [];
  await assert.rejects(
    () =>
      main({
        load: () => cfg,
        log: () => {},
        logErr: (m) => logErrLines.push(m),
        makeRedisImpl: () => null,
        exit: (code) => {
          exits.push(code);
          throw STOP;
        },
      }),
    (err) => err === STOP,
  );
  assert.deepEqual(exits, [1]);
  assert.deepEqual(logErrLines, ["ctf-sync: Secure Development needs Redis to attribute PRs to players"]);
});


test("refuses startup when Redis compatibility validation fails, before loading state or polling", async () => {
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 1000 }),
    makeRedisImpl: () => ({
      ensureCompatible: async () => {
        calls.compatibility++;
        throw new IncompatibleRedisError("incompatible Redis data detected");
      },
    }),
  });

  await assert.rejects(() => main(deps), (err) => err === STOP);

  assert.equal(calls.compatibility, 1);
  assert.equal(calls.readState, 0);
  assert.deepEqual(calls.tick, []);
  assert.deepEqual(calls.sleep, []);
  assert.deepEqual(calls.exit, [1]);
  assert.deepEqual(calls.logErr, [
    "ctf-sync: Redis compatibility check failed: incompatible Redis data detected",
  ]);
});

// ── waiting for Redis, and stopping (#825) ───────────────────────────────────

test("waits for a Redis that is not answering yet with its own log line, then polls", async () => {
  let attempts = 0;
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 1000 }),
    redisWaitMs: 5,
    makeRedisImpl: () => ({
      ensureCompatible: async () => {
        if (++attempts < 3) throw new Error("fetch failed");
      },
      readPollState: async () => null,
      writePollState: async () => {},
    }),
    sleep: (ms) => {
      calls.sleep.push(ms);
      if (ms !== 5) throw STOP; // the poll loop's sleep ends the test
    },
  });
  await assert.rejects(() => main(deps), (err) => err === STOP);
  assert.equal(attempts, 3);
  assert.deepEqual(calls.exit, []);
  assert.equal(calls.tick.length, 1, "it went on to poll");
  assert.ok(calls.logErr.includes("ctf-sync: waiting for Redis (fetch failed), retrying"), JSON.stringify(calls.logErr));
  assert.ok(!calls.logErr.some((l) => /compatibility check failed/.test(l)), "a slow start never reads like the refusal");
});

test("gives up with a distinct line when Redis never answers", async () => {
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 1000 }),
    redisWaitMs: 5,
    redisWaitTries: 3,
    makeRedisImpl: () => ({
      ensureCompatible: async () => {
        throw new Error("fetch failed");
      },
    }),
    sleep: (ms) => calls.sleep.push(ms),
  });
  await assert.rejects(() => main(deps), (err) => err === STOP);
  assert.deepEqual(calls.exit, [1]);
  assert.equal(calls.logErr.at(-1), "ctf-sync: Redis did not answer after 3 tries: fetch failed");
  assert.deepEqual(calls.tick, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("SIGTERM during a tick lets it finish and saves its cursor before exiting 0", async () => {
  let stop;
  const tick = deferred();
  const save = deferred();
  const saved = [];
  let writes = 0;
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 1000 }),
    onStop: (fn) => {
      stop = fn;
    },
    makeRedisImpl: () => ({
      ensureCompatible: async () => {},
      readPollState: async () => null,
      writePollState: async (s) => {
        if (++writes === 2) await save.promise; // the post-tick save, held open
        saved.push(JSON.parse(JSON.stringify(s)));
      },
    }),
    runTick: async (cfg, state) => {
      calls.tick.push(state);
      stop(); // the signal lands mid-tick
      await tick.promise;
      state.repos.vampi = { cursor: "advanced" }; // the tick's progress
      return state;
    },
  });
  const run = main(deps);
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  assert.deepEqual(calls.exit, [], "the tick in progress is not cut off");
  tick.resolve();
  await settle();
  assert.equal(writes, 2, "the post-tick save started");
  assert.deepEqual(calls.exit, [], "it does not exit before the save completes");
  save.resolve();
  await assert.rejects(run, (err) => err === STOP);
  assert.deepEqual(saved.at(-1).repos.vampi, { cursor: "advanced" }, "the saved cursor carries the tick's progress");
  assert.deepEqual(calls.exit, [0]);
  assert.deepEqual(calls.sleep, [], "it never slept after the signal");
});

test("SIGTERM while sleeping between ticks exits 0 at once", async () => {
  let stop;
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 1000 }),
    onStop: (fn) => {
      stop = fn;
    },
    sleep: (ms) => {
      calls.sleep.push(ms);
      stop(); // the signal lands while idle
      throw STOP;
    },
  });
  await assert.rejects(() => main(deps), (err) => err === STOP);
  assert.deepEqual(calls.exit, [0]);
  assert.ok(calls.logErr.includes("ctf-sync: stopping"));
});

test("SIGTERM during a tick retries a failed final cursor save before exiting", async () => {
  let stop;
  let writes = 0;
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 1000 }),
    onStop: (fn) => {
      stop = fn;
    },
    makeRedisImpl: () => ({
      ensureCompatible: async () => {},
      readPollState: async () => null,
      writePollState: async () => {
        writes++;
        if (writes === 2) throw new Error("NOAUTH"); // the post-tick save fails once
      },
    }),
    runTick: async (cfg, state) => {
      stop();
      return state;
    },
    sleep: (ms) => calls.sleep.push(ms),
  });
  await assert.rejects(() => main(deps), (err) => err === STOP);
  assert.equal(writes, 3, "seed write, failed save, successful retry");
  assert.deepEqual(calls.exit, [0]);
  assert.ok(calls.logErr.includes("ctf-sync: stopping"));
});

test("SIGTERM between ticks after a failed cursor save retries the save before exiting", async () => {
  let stop;
  let writes = 0;
  const { deps, calls } = spyDeps({
    load: () => ({ org: "o", statePath: "/s", pollIntervalMs: 30000 }),
    onStop: (fn) => {
      stop = fn;
    },
    makeRedisImpl: () => ({
      ensureCompatible: async () => {},
      readPollState: async () => null,
      writePollState: async () => {
        writes++;
        if (writes === 2) throw new Error("NOAUTH"); // the post-tick save fails
      },
    }),
    sleep: async (ms) => {
      calls.sleep.push(ms);
      if (ms !== 1000) stop(); // the signal lands while idle, after the failed save
    },
  });
  await assert.rejects(() => main(deps), (err) => err === STOP);
  assert.equal(writes, 3, "seed write, failed save, retried before exiting");
  assert.equal(calls.tick.length, 1, "no second tick ran");
  assert.deepEqual(calls.exit, [0]);
  assert.ok(calls.logErr.includes("ctf-sync: stopping"), JSON.stringify(calls.logErr));
});
