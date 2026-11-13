import { test } from "node:test";
import assert from "node:assert/strict";
import { tick as rawTick } from "../src/index.js";
import { makeRedis } from "../src/redis.js";

// Both scoring bugs this event hit had the identical shape: the poller
// consumed a comment, submitted nothing, and said nothing. The `continue`
// that dropped the score sat above every logged branch, so the failure was
// invisible by construction — the leaderboard was simply missing points that
// the PR itself displayed correctly.
//
// These tests pin the counters and the log lines that make that shape
// audible. They are deliberately written against `tick` rather than a helper:
// what matters is not that a counter function increments, but that the real
// ingest loop reaches it on each of its silent paths.

const CFG = {
  org: "evt", getToken: async () => "ghp_test", apiUrl: "https://api.example",
  scorerUrl: "http://scorer:4000", scorerToken: "t", commentAuthor: "github-actions[bot]",
};

// config-v2: targets come from redis.getSecureDevTargets(), not cfg. These
// drop-visibility tests are about DVWA's comment disposition counters; a
// fixed single-target stub keeps them scoped to one repo as before.
const LINKS = { octocat: "11111111-1111-4111-8111-111111111111", mona: "33333333-3333-4333-8333-333333333333" };
const resolveGithubLogin = async (login) => LINKS[login.toLowerCase()] ?? null;
const redisStub = { resolveGithubLogin, getSecureDevTargets: async () => ["dvwa"], isPaused: async () => false, writeStatus: async () => {} };
const tick = (cfg, state, deps = {}) => rawTick(cfg, state, { redis: redisStub, ...deps });

const scoreBody = `<!-- ctf-score: {"author":"octocat","target":"dvwa","solved":["sqli-low"],"pr":7,"sha":"abc"} -->`;
const ghComment = (id, body = scoreBody, updated_at = "2026-08-13T11:00:00Z") => ({
  id, body, user: { login: "github-actions[bot]" }, updated_at,
});

function routes(comments, scoreStatus = 202, posts = []) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes("/issues/comments")) return new Response(JSON.stringify(comments), { status: 200, headers: {} });
    if (u.endsWith("/score")) {
      posts.push(JSON.parse(opts.body));
      return new Response(null, { status: scoreStatus });
    }
    throw new Error(`unexpected url ${u}`);
  };
}

async function run(comments, scoreStatus = 202) {
  const logs = [];
  const posts = [];
  const state = { repos: {} };
  await tick(CFG, state, { fetchImpl: routes(comments, scoreStatus, posts), log: (m) => logs.push(m) });
  return { state, logs, posts };
}

test("a scorer 4xx is counted as dropped, named, and timestamped", async () => {
  const { state, logs } = await run([ghComment(1)], 401);
  assert.equal(state.dropped, 1);
  assert.match(state.lastDrop, /rejected \(4xx\), dropped/);
  assert.match(state.lastDrop, /DVWA#7/, "the drop must name the PR an organizer has to go look at");
  assert.ok(state.lastDropAt, "a drop without a time cannot be correlated with anything");
  assert.ok(logs.some((l) => /rejected \(4xx\), dropped/.test(l)));
});

// The case `parseScoreComment` could not previously express: the comment
// CLAIMS to carry a score and the claim is unreadable. Before the split it
// was indistinguishable from an ordinary bot comment, so a schema drift
// between the workflow and the poller would have looked exactly like silence.
test("a present-but-unusable ctf-score marker is a drop, not routine silence", async () => {
  const broken = ghComment(2, `<!-- ctf-score: {"author":"octocat","target":"NOT-A-TARGET","solved":[]} -->`);
  const { state, logs, posts } = await run([broken]);
  assert.equal(posts.length, 0);
  assert.equal(state.dropped, 1);
  assert.match(state.lastDrop, /unusable ctf-score marker/);
  assert.match(state.lastDrop, /comment 2/, "the drop must name the comment id");
  assert.ok(logs.some((l) => /unusable ctf-score marker/.test(l)));
});

// The counter is only useful if it stays at zero through normal operation.
// A "dropped" figure that ticks up on every placeholder and every boundary
// re-read is one an organizer learns to ignore, which would leave us exactly
// where we started.
test("the workflow's placeholder comment is NOT a drop", async () => {
  const placeholder = ghComment(3, "<!-- ctf-score:dvwa -->\n## 🏆 CTF Patch Score\n\n⏳ Scoring in progress…");
  const { state, posts } = await run([placeholder]);
  assert.equal(posts.length, 0);
  assert.equal(state.dropped, 0, "no marker means no score was ever claimed");
  assert.equal(state.lastDrop, undefined);
});

test("re-reading the cursor's boundary comment is NOT a drop", async () => {
  const logs = [];
  const state = { repos: {} };
  const f = routes([ghComment(4)], 202, []);
  await tick(CFG, state, { fetchImpl: f, log: (m) => logs.push(m) });
  assert.equal(state.ingested, 1);
  // `since` is inclusive, so the same comment comes back on the next tick.
  await tick(CFG, state, { fetchImpl: f, log: (m) => logs.push(m) });
  assert.equal(state.ingested, 1);
  assert.equal(state.dropped, 0);
  assert.deepEqual(logs, [], "a purely routine tick must stay silent, or the real lines get lost in it");
});

test("a 5xx retry is logged but not counted as lost — the next tick re-presents it", async () => {
  const { state, logs } = await run([ghComment(5)], 503);
  assert.equal(state.dropped, 0, "a retried submission is not a dropped one");
  assert.ok(logs.some((l) => /1 retried/.test(l)));
});

test("the per-repo summary breaks a mixed batch down by disposition", async () => {
  const comments = [
    ghComment(10, scoreBody, "2026-08-13T11:00:00Z"),
    ghComment(11, "no marker here at all", "2026-08-13T11:01:00Z"),
    ghComment(12, `<!-- ctf-score: {"author":"bad login!","target":"dvwa","solved":[]} -->`, "2026-08-13T11:02:00Z"),
  ];
  const { logs } = await run(comments);
  const summary = logs.find((l) => l.startsWith("poll DVWA:"));
  assert.ok(summary, "a batch containing anything non-routine must produce a summary line");
  assert.match(summary, /1 ingested/);
  assert.match(summary, /1 noMarker/);
  assert.match(summary, /1 invalid/);
});

// The counters have to survive the trip to Redis, or /admin shows a zero that
// the poller's own state contradicts.
test("dropped and lastDrop reach the sync status hash", async () => {
  const sent = [];
  const env = { UPSTASH_REDIS_REST_URL: "http://srh:80", UPSTASH_REDIS_REST_TOKEN: "t" };
  const redis = makeRedis(env, async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify([{ result: "OK" }, { result: 1 }]), { status: 200 });
  });
  await redis.writeStatus({
    lastPollAt: "2026-08-21T03:00:00Z", ingested: 4, dropped: 2,
    lastDrop: "submit DVWA#7: rejected (4xx), dropped", reposPolled: 6, paused: false, lastError: null,
  });
  const hset = sent[0][0];
  assert.equal(hset[hset.indexOf("dropped") + 1], "2");
  assert.equal(hset[hset.indexOf("lastDrop") + 1], "submit DVWA#7: rejected (4xx), dropped");
});

// `lastError` describes one tick and is cleared by the next quiet one.
// `lastDrop` must NOT be: the score is still missing after the poller
// recovers, so clearing it would erase the only pointer to the PR that needs
// looking at.
test("a later clean tick does not clear lastDrop the way it clears lastError", async () => {
  const sent = [];
  const env = { UPSTASH_REDIS_REST_URL: "http://srh:80", UPSTASH_REDIS_REST_TOKEN: "t" };
  const redis = makeRedis(env, async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify([{ result: "OK" }, { result: 1 }]), { status: 200 });
  });
  await redis.writeStatus({
    lastPollAt: "2026-08-21T03:01:00Z", ingested: 4, dropped: 2,
    lastDrop: "submit DVWA#7: rejected (4xx), dropped", reposPolled: 6, paused: false, lastError: null,
  });
  const cmds = sent[0];
  const deleted = cmds.filter((c) => c[0] === "HDEL").flat();
  assert.ok(deleted.includes("lastError"));
  assert.equal(deleted.includes("lastDrop"), false);
});
