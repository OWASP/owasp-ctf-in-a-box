import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeRedis, outsideScoringWindow, outsideWindow, pausedAt, V1_FINGERPRINT_PATTERNS } from "../src/redis.js";
import { TARGETS } from "../src/config.js";

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const env = { UPSTASH_REDIS_REST_URL: "http://srh:80", UPSTASH_REDIS_REST_TOKEN: "t" };

// Mock fetch that returns a single HMGET [paused, scoringStartsAt, scoringEndsAt] reply.
const hmgetFetch = (row) => async () =>
  new Response(JSON.stringify([{ result: row }]), { status: 200 });

test("sync v1 fingerprint patterns match the shared fixture", async () => {
  const url = new URL("../../test/fixtures/v1-fingerprints.json", import.meta.url);
  const { patterns } = JSON.parse(await readFile(url, "utf8"));
  assert.deepEqual(V1_FINGERPRINT_PATTERNS, patterns);
});

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
  // A floor at the committed row count: an emptied or truncated corpus would
  // otherwise run zero subtests here and pass.
  assert.ok(Array.isArray(cases) && cases.length >= 16, `window-corpus.json has ${cases?.length} rows, expected at least 16`);
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
  // A floor at the committed row count: an emptied or truncated corpus would
  // otherwise run zero subtests here and pass.
  assert.ok(Array.isArray(cases) && cases.length >= 10, `scoring-window-corpus.json has ${cases?.length} rows, expected at least 10`);
  for (const { description, nowMs, startsAt, endsAt, expected } of cases) {
    await t.test(description, () => {
      assert.equal(outsideScoringWindow(nowMs, startsAt, endsAt), expected);
    });
  }
});

// Whether the manual freeze covered an instant. Same rows run against
// apps/web's schedule-window.ts and scorer/src/store.js, which judges a
// score's comment time with it.
test("pausedAt: shared pause-interval corpus", async (t) => {
  const url = new URL("../../test/fixtures/pause-interval-corpus.json", import.meta.url);
  const { cases } = JSON.parse(await readFile(url, "utf8"));
  assert.ok(cases.length > 0, "the corpus must not be empty");
  for (const { description, tMs, paused, pausedSince, pauses, expected } of cases) {
    await t.test(description, () => {
      assert.equal(pausedAt(tMs, paused, pausedSince, pauses), expected);
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

// Shared with apps/web's normalizeSecureDevTargets: the same stored value
// must decode to the same list in both readers, and where either cannot use
// it, each must fail in its own documented direction (the corpus's _comment).
test("getSecureDevTargets: shared secure-dev-targets corpus", async (t) => {
  const url = new URL("../../test/fixtures/secure-dev-targets-corpus.json", import.meta.url);
  const { cases } = JSON.parse(await readFile(url, "utf8"));
  assert.ok(Array.isArray(cases) && cases.length >= 15, `secure-dev-targets-corpus.json has ${cases?.length} rows, expected at least 15`);
  for (const { description, raw, sync } of cases) {
    await t.test(description, async () => {
      const redis = makeRedis(env, hgetFetch(raw));
      if (sync === "refuse") {
        await assert.rejects(() => redis.getSecureDevTargets(), /secureDevTargets/);
      } else {
        assert.deepEqual(await redis.getSecureDevTargets(), sync === "all" ? TARGETS : sync);
      }
    });
  }
});

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

test("holdScore stores the entry under the lowercased login and indexes the author", async () => {
  const sent = [];
  const fetchImpl = async (_u, init) => {
    const cmds = JSON.parse(init.body);
    sent.push(...cmds);
    return new Response(JSON.stringify(cmds.map(() => ({ result: 1 }))), { status: 200 });
  };
  const r = makeRedis({ UPSTASH_REDIS_REST_URL: "http://x", UPSTASH_REDIS_REST_TOKEN: "t" }, fetchImpl, () => {});
  const entry = { target: "dvwa", solved: ["sqli-low"], pr: 7, sha: "abc", at: "2026-08-13T11:00:00Z", repo: "DVWA" };
  await r.holdScore("OctoCat", "1@2026-08-13T11:00:00Z", entry);
  assert.deepEqual(sent, [
    ["HSET", "ctf:sd:held:by:octocat", "1@2026-08-13T11:00:00Z", JSON.stringify(entry)],
    ["SADD", "ctf:sd:held:authors", "octocat"],
  ]);
});

test("holdScore throws on a per-command error", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([{ error: "NOAUTH nope" }, { result: 1 }]), { status: 200 });
  const r = makeRedis({ UPSTASH_REDIS_REST_URL: "http://x", UPSTASH_REDIS_REST_TOKEN: "t" }, fetchImpl, () => {});
  await assert.rejects(r.holdScore("octocat", "f", {}), /NOAUTH/);
});

test("findKeysByPatterns scans multiple patterns and pages, deduplicating keys", async () => {
  const calls = [];
  const pages = [
    ["7", ["ctf:user:alice", "ctf:user:bob"]],
    ["0", ["ctf:user:bob", "ctf:user:charlie"]],
    ["0", ["ctf:team:red"]],
  ];

  const redis = makeRedis(env, async (_url, init) => {
    const commands = JSON.parse(init.body);
    calls.push(commands);
    return new Response(
      JSON.stringify([{ result: pages.shift() }]),
      { status: 200 },
    );
  });

  const keys = await redis.findKeysByPatterns([
    "ctf:user:*",
    "ctf:team:*",
  ]);

  assert.deepEqual(keys, [
    "ctf:user:alice",
    "ctf:user:bob",
    "ctf:user:charlie",
    "ctf:team:red",
  ]);
  assert.deepEqual(calls, [
    [["SCAN", "0", "MATCH", "ctf:user:*", "COUNT", 1000]],
    [["SCAN", "7", "MATCH", "ctf:user:*", "COUNT", 1000]],
    [["SCAN", "0", "MATCH", "ctf:team:*", "COUNT", 1000]],
  ]);
});


test("ensureCompatible: schema v2 marker skips fingerprint scanning", async () => {
  const sent = [];
  const redis = makeRedis(env, async (_url, init) => {
    const commands = JSON.parse(init.body);
    sent.push(...commands);
    return new Response(JSON.stringify([{ result: "2" }]), { status: 200 });
  });

  await redis.ensureCompatible();

  assert.deepEqual(sent, [["GET", "ctf:meta:schema-version"]]);
});

test("ensureCompatible: fresh Redis scans fingerprints and initializes marker with NX", async () => {
  const sent = [];
  const redis = makeRedis(env, async (_url, init) => {
    const commands = JSON.parse(init.body);
    sent.push(...commands);
    return new Response(JSON.stringify(commands.map((command) => ({
      result: command[0] === "GET" ? null : command[0] === "SCAN" ? ["0", []] : "OK",
    }))), { status: 200 });
  });

  await redis.ensureCompatible();

  assert.equal(sent[0][0], "GET");
  const scans = sent.filter((command) => command[0] === "SCAN");
  assert.deepEqual(scans.map((command) => command[3]), V1_FINGERPRINT_PATTERNS);
  assert.deepEqual(sent.at(-1), ["SET", "ctf:meta:schema-version", "2", "NX"]);
});

test("ensureCompatible: recognizable v1 data refuses startup", async () => {
  let scanCount = 0;
  const redis = makeRedis(env, async (_url, init) => {
    const [[command]] = JSON.parse(init.body);
    if (command === "GET") return new Response(JSON.stringify([{ result: null }]), { status: 200 });
    scanCount++;
    return new Response(JSON.stringify([{ result: ["0", ["ctf:user:alice"]] }]), { status: 200 });
  });

  await assert.rejects(redis.ensureCompatible(), (error) => {
    assert.ok(
      error.message.includes(
        "Incompatible Redis data detected (matching fingerprint: ctf:solves:*). " +
        "Export required data, perform a master reset on v1, then deploy v2.",
      ),
    );
    assert.doesNotMatch(error.message, /ctf:user:alice/);
    return true;
  });
  assert.equal(scanCount, 1);
});

test("ensureCompatible: unsupported schema version refuses startup", async () => {
  const redis = makeRedis(env, async () =>
    new Response(JSON.stringify([{ result: "3" }]), { status: 200 }),
  );

  await assert.rejects(redis.ensureCompatible(), /unsupported Redis schema version: 3/);
});

test("ensureCompatible: malformed SCAN response fails closed", async () => {
  const redis = makeRedis(env, async (_url, init) => {
    const [[command]] = JSON.parse(init.body);
    return new Response(JSON.stringify([
      { result: command === "GET" ? null : ["not-a-cursor", []] },
    ]), { status: 200 });
  });

  await assert.rejects(redis.ensureCompatible(), /invalid Redis SCAN response/);
});

test("ensureCompatible: Redis errors fail closed", async () => {
  const redis = makeRedis(env, errorReplyFetch("NOAUTH Authentication required"));
  await assert.rejects(redis.ensureCompatible(), /NOAUTH/);
});

test("ensureCompatible: accepts a v2 marker created during fingerprint scanning", async () => {
  let markerReads = 0;
  const scannedPatterns = [];
  const redis = makeRedis(env, async (_url, init) => {
    const commands = JSON.parse(init.body);
    return new Response(JSON.stringify(commands.map((command) => {
      if (command[0] === "GET") {
        markerReads++;
        return { result: markerReads === 1 ? null : "2" };
      }
      if (command[0] === "SCAN") {
        scannedPatterns.push(command[3]);
        return {
          result: [
            "0",
            command[3] === "ctf:sd:held:*" ? ["ctf:sd:held:by:alice"] : [],
          ],
        };
      }
      return { result: null };
    })), { status: 200 });
  });

  await redis.ensureCompatible();

  assert.equal(markerReads, 2);
  assert.ok(scannedPatterns.includes("ctf:sd:held:*"));
});

test("ensureCompatible: concurrent marker initialization succeeds when another process writes v2", async () => {
  let getCount = 0;
  const sent = [];
  const redis = makeRedis(env, async (_url, init) => {
    const commands = JSON.parse(init.body);
    sent.push(...commands);
    const [command] = commands[0];
    if (command === "GET") {
      getCount++;
      return new Response(JSON.stringify([{ result: getCount === 1 ? null : "2" }]), { status: 200 });
    }
    if (command === "SCAN") {
      return new Response(JSON.stringify([{ result: ["0", []] }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ result: null }]), { status: 200 });
  });

  await redis.ensureCompatible();

  assert.ok(sent.some((command) => JSON.stringify(command) === JSON.stringify(["SET", "ctf:meta:schema-version", "2", "NX"])));
  assert.deepEqual(sent.at(-1), ["GET", "ctf:meta:schema-version"]);
  assert.equal(getCount, 2);
});

// ── releasing held scores (#741) ─────────────────────────────────────────────

/** A recording /pipeline mock answering each command with `reply(cmd)`. */
function recorder(reply) {
  const sent = [];
  const fetchImpl = async (_u, init) => {
    const cmds = JSON.parse(init.body);
    sent.push(...cmds);
    return new Response(JSON.stringify(cmds.map((c) => ({ result: reply(c) }))), { status: 200 });
  };
  return { sent, r: makeRedis({ UPSTASH_REDIS_REST_URL: "http://x", UPSTASH_REDIS_REST_TOKEN: "t" }, fetchImpl, () => {}) };
}
const errorFetch = async () => new Response(JSON.stringify([{ error: "NOAUTH nope" }]), { status: 200 });
const erroring = () => makeRedis({ UPSTASH_REDIS_REST_URL: "http://x", UPSTASH_REDIS_REST_TOKEN: "t" }, errorFetch, () => {});

test("readScoringWindow reads both bounds in one HMGET, absent ones as empty strings", async () => {
  const { sent, r } = recorder(() => [null, "2026-11-13T18:00:00.000Z"]);
  assert.deepEqual(await r.readScoringWindow(), { startsAt: "", endsAt: "2026-11-13T18:00:00.000Z" });
  assert.deepEqual(sent, [["HMGET", "ctf:admin:settings", "scoringStartsAt", "scoringEndsAt"]]);
});

test("readScoringWindow throws on a read error instead of guessing the event never closes", async () => {
  await assert.rejects(erroring().readScoringWindow(), /NOAUTH/);
});

test("heldAuthors is the author index", async () => {
  const { sent, r } = recorder(() => ["octocat", "mona"]);
  assert.deepEqual(await r.heldAuthors(), ["octocat", "mona"]);
  assert.deepEqual(sent, [["SMEMBERS", "ctf:sd:held:authors"]]);
  await assert.rejects(erroring().heldAuthors(), /NOAUTH/);
});

test("heldFor reads the lowercased author's hash; an entry that is not a JSON object comes back null", async () => {
  const entry = { target: "dvwa", solved: ["sqli-low"], pr: 7, sha: "abc", at: "2026-08-13T11:00:00Z", repo: "DVWA" };
  const { sent, r } = recorder(() => ["1@a", JSON.stringify(entry), "2@b", "{bad", "3@c", "[1]", "4@d", "null"]);
  assert.deepEqual(await r.heldFor("OctoCat"), [
    { field: "1@a", entry },
    { field: "2@b", entry: null },
    { field: "3@c", entry: null },
    { field: "4@d", entry: null },
  ]);
  assert.deepEqual(sent, [["HGETALL", "ctf:sd:held:by:octocat"]]);
  await assert.rejects(erroring().heldFor("octocat"), /NOAUTH/);
});

test("resolveGithubLink reads the link, then its time from ctf:link:at by player id", async () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const { sent, r } = recorder((c) => (c[0] === "GET" ? P : "1763056800000"));
  assert.deepEqual(await r.resolveGithubLink("OctoCat"), { player: P, linkedAt: 1763056800000 });
  assert.deepEqual(sent, [["GET", "ctf:link:github:octocat"], ["HGET", "ctf:link:at", P]]);
});

test("resolveGithubLink: unlinked is null, and a link with no usable time has linkedAt null", async () => {
  const P = "11111111-1111-4111-8111-111111111111";
  assert.equal(await recorder(() => null).r.resolveGithubLink("nobody"), null);
  for (const at of [null, "", "soon", "12.5", "-1"]) {
    const { r } = recorder((c) => (c[0] === "GET" ? P : at));
    assert.deepEqual(await r.resolveGithubLink("octocat"), { player: P, linkedAt: null }, `ctf:link:at = ${JSON.stringify(at)}`);
  }
  await assert.rejects(erroring().resolveGithubLink("octocat"), /NOAUTH/);
});

test("releaseHeld is one EVAL: HDEL the field, SREM the author once the hash is empty", async () => {
  const { sent, r } = recorder(() => 1);
  await r.releaseHeld("OctoCat", "1@2026-08-13T11:00:00Z");
  assert.equal(sent.length, 1);
  const [cmd, script, numkeys, ...rest] = sent[0];
  assert.equal(cmd, "EVAL");
  assert.equal(numkeys, 2);
  assert.deepEqual(rest, ["ctf:sd:held:by:octocat", "ctf:sd:held:authors", "1@2026-08-13T11:00:00Z", "octocat"]);
  assert.match(script, /redis\.call\('HDEL', KEYS\[1\], ARGV\[1\]\)/);
  assert.match(script, /redis\.call\('HLEN', KEYS\[1\]\) == 0/);
  assert.match(script, /redis\.call\('SREM', KEYS\[2\], ARGV\[2\]\)/);
  assert.ok(script.indexOf("HDEL") < script.indexOf("HLEN"), "the emptiness check must follow the delete");
  await assert.rejects(erroring().releaseHeld("octocat", "f"), /NOAUTH/);
});
