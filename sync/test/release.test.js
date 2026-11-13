import { test } from "node:test";
import assert from "node:assert/strict";
import { linkAfterClose, releaseHeldScores, tick } from "../src/index.js";

// Releasing a held Secure Development score: the PR author linked a kit
// account, so the scores parked under their login go to the scorer with the
// player id and the comment's ORIGINAL time. Whether a link counts is decided
// by when it was made against the scoring close, never by when sync notices.

const CFG = {
  org: "evt", getToken: async () => "ghp_test", apiUrl: "https://api.example",
  scorerUrl: "http://scorer:4000", scorerToken: "t", commentAuthor: "github-actions[bot]",
};

const PLAYER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const END = "2026-11-13T18:00:00.000Z";
const T = Date.parse(END);
const MIN = 60_000;

const entryA = { target: "dvwa", solved: ["sqli-low"], pr: 7, sha: "aaa111", at: "2026-11-13T10:00:00Z", repo: "DVWA" };
const entryB = { target: "vampi", solved: ["bola"], pr: 9, sha: "bbb222", at: "2026-11-13T11:00:00Z", repo: "VAmPI" };

/** In-memory stand-in for the release half of makeRedis. `held` is
 *  { login: { field: rawJson } }, mutated by releaseHeld exactly as the Lua
 *  script would: the field goes, and the author with it once nothing is left. */
function fakeRedis({ links = {}, held = {}, window = { startsAt: "", endsAt: END }, failRelease = false, failResolve = [] } = {}) {
  const deleted = [];
  return {
    held,
    deleted,
    heldAuthors: async () => Object.keys(held),
    readScoringWindow: async () => window,
    heldFor: async (login) =>
      Object.entries(held[login] ?? {}).map(([field, raw]) => {
        let entry = null;
        try {
          const v = JSON.parse(raw);
          entry = v && typeof v === "object" && !Array.isArray(v) ? v : null;
        } catch {
          entry = null;
        }
        return { field, entry };
      }),
    resolveGithubLink: async (login) => {
      if (failResolve.includes(login)) throw new Error("upstash: NOAUTH");
      return links[login] ?? null;
    },
    releaseHeld: async (login, field) => {
      if (failRelease) throw new Error("upstash: NOAUTH");
      deleted.push([login, field]);
      delete held[login][field];
      if (Object.keys(held[login]).length === 0) delete held[login];
    },
  };
}

/** A scorer that answers each POST with `status(payload, n)` — a number, or
 *  "throw" for a network failure. */
function scorer(status = () => 202) {
  const posts = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (!u.endsWith("/score")) throw new Error(`unexpected url ${u}`);
    const payload = JSON.parse(opts.body);
    posts.push(payload);
    const s = status(payload, posts.length);
    if (s === "throw") throw new Error("fetch failed");
    if (s === 422) return new Response(JSON.stringify({ refused: "paused" }), { status: 422 });
    return new Response(null, { status: s });
  };
  return { posts, fetchImpl };
}

// Held in the reverse of comment order, so "oldest first" is the sort's doing.
const twoHeld = () => ({ octocat: { "2@2026-11-13T11:00:00Z": JSON.stringify(entryB), "1@2026-11-13T10:00:00Z": JSON.stringify(entryA) } });
const strip = ({ repo: _r, ...rest }) => rest;

test("a link made before the close releases every held score at its own time, oldest first, then deletes it", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T - MIN } }, held: twoHeld() });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(posts, [
    { player: PLAYER, ...strip(entryA) },
    { player: PLAYER, ...strip(entryB) },
  ], "exactly {player,target,solved,pr,sha,at}, the original comment time, no repo");
  assert.deepEqual(redis.deleted, [["octocat", "1@2026-11-13T10:00:00Z"], ["octocat", "2@2026-11-13T11:00:00Z"]]);
  assert.deepEqual(redis.held, {});
  assert.equal(r.released, 2);
  assert.equal(r.accepted, 2);
  assert.equal(r.kept, 0);
});

test("a link made after the close posts nothing and deletes nothing", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T + 5 * MIN } }, held: twoHeld() });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(posts, []);
  assert.deepEqual(redis.deleted, []);
  assert.equal(Object.keys(redis.held.octocat).length, 2);
  assert.equal(r.released, 0);
  assert.equal(r.kept, 2);
});

test("a link made at the very instant of the close is after it: kept", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T } }, held: twoHeld() });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(posts, []);
  assert.equal(r.kept, 2);
});

test("with no scoringEndsAt the event never closes: a late link still releases", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T + 5 * MIN } }, held: twoHeld(), window: { startsAt: "", endsAt: "" } });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 2);
  assert.equal(r.released, 2);
});

test("an unparseable scoringEndsAt is no close either", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T + 5 * MIN } }, held: twoHeld(), window: { startsAt: "", endsAt: "not a date" } });
  const { posts, fetchImpl } = scorer();
  await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 2);
});

test("a link with no recorded time cannot prove it beat the close: kept", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: null } }, held: twoHeld() });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(posts, []);
  assert.deepEqual(redis.deleted, []);
  assert.equal(r.kept, 2);
});

test("a link with no recorded time on an event with no end is released", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: null } }, held: twoHeld(), window: { startsAt: "", endsAt: "" } });
  const { posts, fetchImpl } = scorer();
  await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 2);
});

test("a scorer refusal (frozen at the comment's time) is final: deleted, counted refused, not retried", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T - MIN } }, held: { octocat: { "1@2026-11-13T10:00:00Z": JSON.stringify(entryA) } } });
  const { posts, fetchImpl } = scorer(() => 422);
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 1);
  assert.deepEqual(redis.deleted, [["octocat", "1@2026-11-13T10:00:00Z"]]);
  assert.equal(r.released, 1);
  assert.equal(r.refused, 1);
  assert.equal(r.accepted, 0);
  await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 1, "a judged score is never posted again");
});

test("a scorer 4xx rejection is final too: deleted and counted rejected", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T - MIN } }, held: { octocat: { "1@2026-11-13T10:00:00Z": JSON.stringify(entryA) } } });
  const { fetchImpl } = scorer(() => 400);
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(redis.deleted, [["octocat", "1@2026-11-13T10:00:00Z"]]);
  assert.equal(r.released, 1);
  assert.equal(r.rejected, 1);
});

for (const [name, status] of [["5xx", () => 503], ["network error", () => "throw"]]) {
  test(`a scorer ${name} on the first entry deletes nothing and does not post the second`, async () => {
    const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T - MIN } }, held: twoHeld() });
    const { posts, fetchImpl } = scorer(status);
    const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { player: PLAYER, ...strip(entryA) }, "the oldest is tried first");
    assert.deepEqual(redis.deleted, []);
    assert.equal(Object.keys(redis.held.octocat).length, 2);
    assert.equal(r.released, 0);
    assert.equal(r.kept, 2);
    assert.equal(r.retried, 1);
  });
}

test("a failed delete after the scorer judged it keeps the rest for the next tick", async () => {
  const redis = fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T - MIN } }, held: twoHeld(), failRelease: true });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 1, "stops at the entry it could not delete");
  assert.equal(r.released, 0);
  assert.equal(r.accepted, 0, "not counted until the entry is gone, or the retry counts it twice");
  assert.equal(r.kept, 2);
});

test("an unlinked author is untouched", async () => {
  const redis = fakeRedis({ links: {}, held: twoHeld() });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(posts, []);
  assert.deepEqual(redis.deleted, []);
  assert.equal(r.kept, 2);
  assert.equal(r.released, 0);
});

test("one author's unreadable link does not stop the next author's release", async () => {
  const redis = fakeRedis({
    links: { mona: { player: OTHER, linkedAt: T - MIN } },
    held: { ...twoHeld(), mona: { "3@2026-11-13T12:00:00Z": JSON.stringify(entryA) } },
    failResolve: ["octocat"],
  });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.deepEqual(posts.map((p) => p.player), [OTHER]);
  assert.equal(r.released, 1);
  assert.equal(r.kept, 2);
  assert.equal(r.retried, 1);
});

test("an entry whose JSON or time will not parse is kept and counted, and the rest still release", async () => {
  const redis = fakeRedis({
    links: { octocat: { player: PLAYER, linkedAt: T - MIN } },
    held: { octocat: {
      "1@x": "{not json",
      "2@x": JSON.stringify({ ...entryA, at: "yesterday-ish" }),
      "3@x": JSON.stringify([1, 2]),
      "4@2026-11-13T10:00:00Z": JSON.stringify(entryA),
    } },
  });
  const { posts, fetchImpl } = scorer();
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: () => {} });
  assert.equal(posts.length, 1);
  assert.deepEqual(redis.deleted, [["octocat", "4@2026-11-13T10:00:00Z"]]);
  assert.equal(r.unreadable, 3);
  assert.equal(r.kept, 3);
  assert.equal(r.released, 1);
});

test("nothing held: one read, nothing else", async () => {
  let windowReads = 0;
  const redis = { ...fakeRedis(), readScoringWindow: async () => { windowReads++; return { startsAt: "", endsAt: END }; } };
  const r = await releaseHeldScores({ cfg: CFG, redis, fetchImpl: scorer().fetchImpl, log: () => {} });
  assert.equal(windowReads, 0);
  assert.deepEqual(r, { released: 0, accepted: 0, refused: 0, rejected: 0, kept: 0, retried: 0, unreadable: 0 });
});

test("linkAfterClose: the one close rule, end-exclusive for a link", () => {
  assert.equal(linkAfterClose({ linkedAt: T - 1 }, END), false);
  assert.equal(linkAfterClose({ linkedAt: T }, END), true, "a link at the close instant is after it");
  assert.equal(linkAfterClose({ linkedAt: T + 1 }, END), true);
  assert.equal(linkAfterClose({ linkedAt: null }, END), true, "no time cannot prove it beat the close");
  assert.equal(linkAfterClose({ linkedAt: T + 1 }, ""), false, "no end: the event never closes");
  assert.equal(linkAfterClose({ linkedAt: null }, ""), false);
  assert.equal(linkAfterClose({ linkedAt: T + 1 }, "not a date"), false);
});

// ── inside the tick ─────────────────────────────────────────────────────────

const tickRedis = (over = {}) => ({
  getSecureDevTargets: async () => ["dvwa"],
  isPaused: async () => false,
  writeStatus: async () => {},
  ...fakeRedis({ links: { octocat: { player: PLAYER, linkedAt: T - MIN } }, held: { octocat: { "1@2026-11-13T10:00:00Z": JSON.stringify(entryA) } } }),
  ...over,
});
const liveComment = {
  id: 50, user: { login: "github-actions[bot]" }, updated_at: "2026-11-13T12:00:00Z",
  body: `<!-- ctf-score: {"author":"octocat","target":"dvwa","solved":["xss-low"],"pr":12,"sha":"ccc333"} -->`,
};

function tickFetch(order, scoreStatus = () => 202) {
  const posts = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.includes("/issues/comments")) {
      order.push("comments");
      return new Response(JSON.stringify([liveComment]), { status: 200 });
    }
    if (u.endsWith("/score")) {
      const p = JSON.parse(opts.body);
      order.push(`score:${p.sha}`);
      posts.push(p);
      return new Response(null, { status: scoreStatus(p) });
    }
    throw new Error(`unexpected url ${u}`);
  };
  return { posts, fetchImpl };
}

test("the tick releases held scores before it reads new comments, and counts them as ingested", async () => {
  const order = [];
  const { fetchImpl } = tickFetch(order);
  const state = { repos: {} };
  const logs = [];
  await tick(CFG, state, { redis: tickRedis(), fetchImpl, log: (m) => logs.push(m) });
  assert.deepEqual(order, ["score:aaa111", "comments", "score:ccc333"]);
  assert.equal(state.ingested, 2);
  assert.ok(logs.some((l) => /^release: .*1 released/.test(l)), `a release summary line: ${JSON.stringify(logs)}`);
});

test("a held score the scorer rejects on release is counted as dropped", async () => {
  const order = [];
  const { fetchImpl } = tickFetch(order, (p) => (p.sha === "aaa111" ? 400 : 202));
  const state = { repos: {} };
  await tick(CFG, state, { redis: tickRedis(), fetchImpl, log: () => {} });
  assert.equal(state.dropped, 1);
  assert.match(state.lastDrop, /^release: 1 held score rejected \(4xx\), dropped$/);
  assert.equal(state.ingested, 1);
});

test("a failed release step is logged and the comment pass still runs", async () => {
  const order = [];
  const { posts, fetchImpl } = tickFetch(order);
  const logs = [];
  // The author index, which only the release step reads. (An unreadable
  // window stops the comment pass from judging a link too: tick.test.js.)
  const redis = tickRedis({ heldAuthors: async () => { throw new Error("upstash: NOAUTH"); } });
  await tick(CFG, { repos: {} }, { redis, fetchImpl, log: (m) => logs.push(m) });
  assert.deepEqual(posts.map((p) => p.sha), ["ccc333"], "the new comment still scores");
  assert.equal(Object.keys(redis.held.octocat).length, 1, "the held entry waits for the next tick");
  assert.ok(logs.some((l) => /^release: skipped this tick \(upstash: NOAUTH\)/.test(l)), JSON.stringify(logs));
});

test("release log lines carry counts and reasons only — no login, player id, PR, sha, repo or comment id", async () => {
  const logs = [];
  const redis = fakeRedis({
    links: { octocat: { player: PLAYER, linkedAt: T - MIN }, mona: { player: OTHER, linkedAt: T - MIN } },
    held: { ...twoHeld(), mona: { "3@2026-11-13T12:00:00Z": JSON.stringify(entryA), "4@x": "{bad" } },
  });
  let n = 0;
  const { fetchImpl } = scorer(() => [202, 422, 503][n++ % 3]);
  await releaseHeldScores({ cfg: CFG, redis, fetchImpl, log: (m) => logs.push(m) });
  const stateLogs = [];
  await tick(CFG, { repos: {} }, {
    redis: tickRedis(), fetchImpl: tickFetch([], () => 400).fetchImpl, log: (m) => stateLogs.push(m),
  });
  const all = [...logs, ...stateLogs.filter((l) => l.startsWith("release"))];
  assert.ok(all.length > 0, "something must have been logged to check");
  for (const l of all) {
    for (const secret of ["octocat", "mona", PLAYER, OTHER, "aaa111", "bbb222", "DVWA", "VAmPI", "#7", "#9", "1@", "3@", "4@"]) {
      assert.ok(!l.includes(secret), `log line leaks ${secret}: ${l}`);
    }
  }
});
