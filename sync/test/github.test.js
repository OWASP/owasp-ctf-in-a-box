import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchNewScoreComments } from "../src/github.js";

const CFG = {
  apiUrl: "https://api.example",
  org: "evt",
  getToken: async () => "ghp_x",
  commentAuthor: "github-actions[bot]",
};

const comment = (id, login, updated_at) => ({ id, body: "b", user: { login }, updated_at });

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
  fn.calls = calls;
  return fn;
}

const jsonRes = (arr, etag = 'W/"e1"') =>
  new Response(JSON.stringify(arr), { status: 200, headers: { etag, "content-type": "application/json" } });

test("filters to trusted comment author and advances cursor", async () => {
  const f = fakeFetch(() =>
    jsonRes([comment(1, "mallory", "2026-08-13T10:00:00Z"), comment(2, "github-actions[bot]", "2026-08-13T11:00:00Z")]),
  );
  const { comments, cursor } = await fetchNewScoreComments(CFG, "DVWA", { since: null, etag: null }, f);
  assert.deepEqual(comments.map((c) => c.id), [2]);
  assert.equal(cursor.since, "2026-08-13T11:00:00Z");
  assert.equal(cursor.etag, 'W/"e1"');
  const url = f.calls[0].url;
  assert.match(url, /^https:\/\/api\.example\/repos\/evt\/DVWA\/issues\/comments\?/);
  assert.match(url, /per_page=100/);
  assert.equal(f.calls[0].opts.headers.authorization, "Bearer ghp_x");
});

test("uses the bearer from cfg.getToken", async () => {
  const cfg = { apiUrl: "https://api.github.test", org: "o", commentAuthor: "github-actions[bot]", getToken: async () => "ghs_fresh" };
  let seen;
  const fetchImpl = async (url, { headers }) => {
    seen = headers.authorization;
    return { status: 200, ok: true, json: async () => [], headers: new Map() };
  };
  await fetchNewScoreComments(cfg, "DVWA", {}, fetchImpl);
  assert.equal(seen, "Bearer ghs_fresh");
});

test("sends since + if-none-match; 304 returns empty and keeps cursor", async () => {
  const f = fakeFetch(() => new Response(null, { status: 304 }));
  const prev = { since: "2026-08-13T11:00:00Z", etag: 'W/"e1"' };
  const { comments, cursor } = await fetchNewScoreComments(CFG, "DVWA", prev, f);
  assert.deepEqual(comments, []);
  assert.deepEqual(cursor, prev);
  assert.match(f.calls[0].url, /since=2026-08-13T11%3A00%3A00Z/);
  assert.equal(f.calls[0].opts.headers["if-none-match"], 'W/"e1"');
});

test("non-ok response throws", async () => {
  const f = fakeFetch(() => new Response("nope", { status: 500 }));
  await assert.rejects(fetchNewScoreComments(CFG, "DVWA", { since: null, etag: null }, f), /GitHub 500/);
});
