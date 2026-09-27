import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMemoryStore, createRedisStore, solvesKey } from "../src/store.js";

const T0 = "2026-08-14T10:00:00.000Z";
const T1 = "2026-08-14T11:00:00.000Z";

test("memory store keeps first-solve timestamps; replays no-op", async () => {
  const store = createMemoryStore();
  await store.recordSolves("dvwa", "octocat", ["sqli-low", "xss-dom"], T0);
  await store.recordSolves("dvwa", "octocat", ["sqli-low"], T1); // replay
  assert.deepEqual(await store.getSolves("dvwa"), {
    "octocat:sqli-low": T0,
    "octocat:xss-dom": T0,
  });
  assert.deepEqual(await store.getSolves("juice-shop"), {}); // targets isolated
});

test("redis store: HSETNX command arrays via SRH pipeline, bearer token", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const commands = JSON.parse(opts.body);
    return new Response(JSON.stringify(commands.map(() => ({ result: 1 }))), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const store = createRedisStore({ url: "http://srh:80/", token: "redis-token" });
  await store.recordSolves("dvwa", "octocat", ["sqli-low", "xss-dom"], T0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://srh:80/pipeline");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.authorization, "Bearer redis-token");
  // Monotonic writes: HSETNX only — a replay must never touch the timestamp.
  assert.deepEqual(JSON.parse(calls[0].opts.body), [
    ["HSETNX", "ctf:solves:dvwa", "octocat:sqli-low", T0],
    ["HSETNX", "ctf:solves:dvwa", "octocat:xss-dom", T0],
  ]);

  await store.recordSolves("dvwa", "octocat", [], T1);
  assert.equal(calls.length, 1); // nothing to write, no round-trip
});

test("redis store: HGETALL parses the flat field/value array", async (t) => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(
      JSON.stringify([{ result: ["octocat:sqli-low", T0, "hubot:xss-dom", T1] }]),
      { status: 200 },
    );
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const store = createRedisStore({ url: "http://srh:80", token: "redis-token" });
  assert.deepEqual(await store.getSolves("dvwa"), {
    "octocat:sqli-low": T0,
    "hubot:xss-dom": T1,
  });
  assert.deepEqual(bodies, [[["HGETALL", "ctf:solves:dvwa"]]]);
});

test("redis store: HTTP failure and per-command errors throw", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  globalThis.fetch = async () => new Response("boom", { status: 503 });
  await assert.rejects(
    createRedisStore({ url: "http://srh:80", token: "redis-token" }).getSolves("dvwa"),
    /upstash pipeline: HTTP 503/,
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ error: "WRONGTYPE" }]), { status: 200 });
  await assert.rejects(
    createRedisStore({ url: "http://srh:80", token: "redis-token" }).getSolves("dvwa"),
    /upstash: WRONGTYPE/,
  );
});

test("redis store refuses to build without URL/token", () => {
  assert.throws(() => createRedisStore({ url: "", token: "" }), /UPSTASH_REDIS_REST_URL\/TOKEN/);
});

test("solvesKey matches the ctf:solves:<target> data model", () => {
  assert.equal(solvesKey("juice-shop"), "ctf:solves:juice-shop");
});

test("memory store getTeams: [] by default, returns seeded teams with sorted members", async () => {
  const empty = createMemoryStore();
  assert.deepEqual(await empty.getTeams(), []);

  const store = createMemoryStore({
    teams: [
      { slug: "red-team", name: "Red Team", captain: "octocat", members: ["hubot", "octocat"] },
      { slug: "blue-team", name: "Blue Team", captain: "hal9000", members: ["zeus", "ada"] },
    ],
  });
  assert.deepEqual(await store.getTeams(), [
    { slug: "red-team", name: "Red Team", captain: "octocat", members: ["hubot", "octocat"] },
    { slug: "blue-team", name: "Blue Team", captain: "hal9000", members: ["ada", "zeus"] },
  ]);
});

test("redis store getTeams: SCANs ctf:team:*:members, HGET/SMEMBERS per slug", async (t) => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const commands = JSON.parse(opts.body);
    bodies.push(commands);
    if (commands[0][0] === "SCAN") {
      return new Response(
        JSON.stringify([{ result: ["0", ["ctf:team:red-team:members", "ctf:team:blue-team:members"]] }]),
        { status: 200 },
      );
    }
    // HGET name, HGET captain, SMEMBERS for red-team, then blue-team
    return new Response(
      JSON.stringify(
        [
          { result: "Red Team" },
          { result: "octocat" },
          { result: ["octocat", "hubot"] },
          { result: "Blue Team" },
          { result: "hal9000" },
          { result: ["zeus", "ada"] },
        ],
      ),
      { status: 200 },
    );
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const store = createRedisStore({ url: "http://srh:80", token: "redis-token" });
  assert.deepEqual(await store.getTeams(), [
    { slug: "red-team", name: "Red Team", captain: "octocat", members: ["hubot", "octocat"] },
    { slug: "blue-team", name: "Blue Team", captain: "hal9000", members: ["ada", "zeus"] },
  ]);
  assert.deepEqual(bodies[0], [["SCAN", "0", "MATCH", "ctf:team:*:members", "COUNT", 1000]]);
  assert.deepEqual(bodies[1], [
    ["HGET", "ctf:team:red-team", "name"],
    ["HGET", "ctf:team:red-team", "captain"],
    ["SMEMBERS", "ctf:team:red-team:members"],
    ["HGET", "ctf:team:blue-team", "name"],
    ["HGET", "ctf:team:blue-team", "captain"],
    ["SMEMBERS", "ctf:team:blue-team:members"],
  ]);
});

test("redis store getTeams: no teams -> []", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ result: ["0", []] }]), { status: 200 });
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const store = createRedisStore({ url: "http://srh:80", token: "redis-token" });
  assert.deepEqual(await store.getTeams(), []);
});

test("redis store getTeams: falls back to slug when name is empty", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const commands = JSON.parse(opts.body);
    if (commands[0][0] === "SCAN") {
      return new Response(
        JSON.stringify([{ result: ["0", ["ctf:team:nameless:members"]] }]),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify([{ result: null }, { result: "octocat" }, { result: ["octocat"] }]),
      { status: 200 },
    );
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const store = createRedisStore({ url: "http://srh:80", token: "redis-token" });
  assert.deepEqual(await store.getTeams(), [
    { slug: "nameless", name: "nameless", captain: "octocat", members: ["octocat"] },
  ]);
});

// --- isPaused honors the scheduled scoring window (manual toggle OR window) ---
import { outsideScoringWindow, outsideWindow } from "../src/store.js";

// Mock a single HMGET [paused, scoringStartsAt, scoringEndsAt] reply.
function pausedFetch(row) {
  return async (_url, _opts) => new Response(JSON.stringify([{ result: row }]), { status: 200 });
}
const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

test("outsideWindow: before start / after end / inside / unbounded / bad", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  assert.equal(outsideWindow(now, FUTURE, null), true);   // before start
  assert.equal(outsideWindow(now, null, PAST), true);     // after end
  assert.equal(outsideWindow(now, PAST, FUTURE), false);  // inside
  assert.equal(outsideWindow(now, null, null), false);    // unbounded
  assert.equal(outsideWindow(now, "nope", "bad"), false); // unparseable ignored
});

// Shared differential corpus (issue #232): same cases run verbatim against
// apps/web's schedule-window.ts and sync/src/redis.js, so a <-><= flip
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
// against apps/web's schedule-window.ts and sync/src/redis.js.
test("outsideScoringWindow: shared scoring-window corpus (#464)", async (t) => {
  const url = new URL("../../test/fixtures/scoring-window-corpus.json", import.meta.url);
  const { cases } = JSON.parse(await readFile(url, "utf8"));
  for (const { description, nowMs, startsAt, endsAt, expected } of cases) {
    await t.test(description, () => {
      assert.equal(outsideScoringWindow(nowMs, startsAt, endsAt), expected);
    });
  }
});

test("redis store isPaused: no scoringStartsAt means not launched, so paused (#464)", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = pausedFetch([null, null, null]);
  t.after(() => { globalThis.fetch = realFetch; });
  const store = createRedisStore({ url: "http://srh:80", token: "t" });
  assert.equal(await store.isPaused(), true);
});

test("redis store isPaused: manual paused flag wins", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = pausedFetch(["1", null, null]);
  t.after(() => { globalThis.fetch = realFetch; });
  const store = createRedisStore({ url: "http://srh:80", token: "t" });
  assert.equal(await store.isPaused(), true);
});

test("redis store isPaused: scheduled window (after end) pauses even without the manual flag", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = pausedFetch([null, null, PAST]);
  t.after(() => { globalThis.fetch = realFetch; });
  const store = createRedisStore({ url: "http://srh:80", token: "t" });
  assert.equal(await store.isPaused(), true);
});

test("redis store isPaused: inside the window is not paused", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = pausedFetch([null, PAST, FUTURE]);
  t.after(() => { globalThis.fetch = realFetch; });
  const store = createRedisStore({ url: "http://srh:80", token: "t" });
  assert.equal(await store.isPaused(), false);
});

test("redis store isPaused: fails OPEN when redis errors", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("redis down"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const store = createRedisStore({ url: "http://srh:80", token: "t" });
  assert.equal(await store.isPaused(), false);
});

// Fail-open is the right direction for the pause read, but silently is not:
// sync/src/redis.js logs the same failure, and an operator watching the
// scorer's stream must see a Redis outage too.
test("redis store isPaused: a failed read fails OPEN and is logged", async () => {
  const logs = [];
  const store = createRedisStore({
    url: "http://srh:80",
    token: "t",
    fetchImpl: async () => { throw new Error("redis down"); },
    log: (m) => logs.push(m),
  });
  assert.equal(await store.isPaused(), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /isPaused.*redis down/);
});

test("redis store: a hung backend times out instead of hanging the request", async () => {
  /** A fake fetch that settles only when its signal aborts. The ref'd timer
   *  does two jobs: it keeps the event loop alive (a real fetch holds a
   *  socket, but `AbortSignal.timeout`'s own timer is unref'd, so without it
   *  Node 22 drains the loop before the timeout fires and the test dies as
   *  "promise still pending"), and it fails the test fast if the abort never
   *  arrives. */
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
  const store = createRedisStore({ url: "http://srh:80", token: "t", fetchImpl: hangUntilAborted, timeoutMs: 20 });
  await assert.rejects(store.getSolves("dvwa"), /timeout/i);
});

// Same rule as sync/src/redis.js: a Redis error's "with args beginning with"
// tail echoes the caller's own arguments, which must never reach a log or an
// error body. The store keeps the error's Redis text and drops the echo.
test("redis store: a per-command error surfaces its Redis text, never its echoed arguments", async () => {
  const store = createRedisStore({
    url: "http://srh:80",
    token: "t",
    fetchImpl: async () =>
      new Response(JSON.stringify([{ error: "ERR unknown command 'hgetall', with args beginning with: 'ctf:solves:dvwa' 'sneaky' " }]), { status: 200 }),
  });
  await assert.rejects(store.getSolves("dvwa"), (err) => {
    assert.match(err.message, /ERR unknown command 'hgetall'/);
    assert.doesNotMatch(err.message, /sneaky|with args beginning with/);
    return true;
  });
});

test("redis store: a per-command error longer than 200 characters is capped", async () => {
  const store = createRedisStore({
    url: "http://srh:80",
    token: "t",
    fetchImpl: async () => new Response(JSON.stringify([{ error: `ERR ${"x".repeat(1000)}` }]), { status: 200 }),
  });
  await assert.rejects(store.getSolves("dvwa"), (err) => {
    assert.equal(err.message.replace(/^upstash: /, "").length, 200);
    return true;
  });
});
