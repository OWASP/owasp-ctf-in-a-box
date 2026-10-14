import { test } from "node:test";
import assert from "node:assert/strict";
import { submitScore } from "../src/submit.js";

const CFG = { scorerUrl: "http://scorer:4000", scorerToken: "s3cret" };
const PAYLOAD = { author: "octocat", target: "dvwa", solved: ["sqli-low"], pr: 7, sha: "abc", at: "2026-08-13T11:00:00Z" };

test("POSTs payload with bearer token, accepted on 202", async () => {
  let seen;
  const f = async (url, opts) => {
    seen = { url: String(url), opts };
    return new Response(null, { status: 202 });
  };
  assert.deepEqual(await submitScore(CFG, PAYLOAD, f), { outcome: "accepted" });
  assert.equal(seen.url, "http://scorer:4000/score");
  assert.equal(seen.opts.method, "POST");
  assert.equal(seen.opts.headers.authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(seen.opts.body), PAYLOAD);
});

test("rejected on 4xx (do not retry)", async () => {
  const f = async () => new Response("bad author", { status: 400 });
  assert.deepEqual(await submitScore(CFG, PAYLOAD, f), { outcome: "rejected" });
});

// 422 is the scorer's final verdict on WHEN the score was posted: outside the
// scoring window, during a freeze, or before the last master reset. Not a
// loss to investigate, so it is told apart from every other 4xx.
test("refused on 422, carrying the scorer's reason", async () => {
  const f = async () =>
    new Response(JSON.stringify({ error: "the score was posted while scoring was frozen", refused: "paused" }), { status: 422 });
  assert.deepEqual(await submitScore(CFG, PAYLOAD, f), { outcome: "refused", reason: "paused" });
});

test("refused on a 422 whose body is unreadable, with an unknown reason", async () => {
  const f = async () => new Response("not json", { status: 422 });
  assert.deepEqual(await submitScore(CFG, PAYLOAD, f), { outcome: "refused", reason: "unknown" });
});

test("throws on 5xx (retry next tick)", async () => {
  const f = async () => new Response("boom", { status: 503 });
  await assert.rejects(submitScore(CFG, PAYLOAD, f), /scorer 503/);
});
