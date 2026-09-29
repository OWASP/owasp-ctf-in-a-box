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

const STOP = new Error("stop-the-poll-loop");

function spyDeps(overrides = {}) {
  const calls = { readState: 0, makeRedis: 0, tick: [], writeState: [], pollState: [], sleep: [], log: [], logErr: [], exit: [] };
  const deps = {
    log: (m) => calls.log.push(m),
    logErr: (m) => calls.logErr.push(m),
    readState: (p) => {
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

// With no admin override readable at all (no Redis client), tick() falls
// back to polling every target — worth telling the organizer at boot rather
// than leaving it to be inferred from the poll logs.
test("warns once at boot when there is no Redis client, and still starts the poll loop", async () => {
  const cfg = { org: "o", statePath: "/s", pollIntervalMs: 1000 };
  const logErrLines = [];
  const tickCalls = [];
  await assert.rejects(
    () =>
      main({
        load: () => cfg,
        log: () => {},
        logErr: (m) => logErrLines.push(m),
        readState: () => ({ repos: {} }),
        makeRedisImpl: () => null,
        runTick: async (c, state, opts) => {
          tickCalls.push(opts);
          return state;
        },
        writeState: () => {},
        sleep: () => {
          throw STOP;
        },
      }),
    (err) => err === STOP,
  );
  assert.equal(tickCalls[0].redis, null);
  assert.deepEqual(logErrLines, ["ctf-sync: polling o every 1000ms", "ctf-sync: no Redis client — polling all six targets"]);
});
