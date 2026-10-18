import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "../src/server.js";
import { createHandler } from "../src/app.js";

const SECRET = "webhook-secret";
const APP_ID = 12345;
const REPO = "example/repo";
const HEAD = "1111111111111111111111111111111111111111";
const QUIET = { warn() {}, error() {}, info() {} };

function rev(state, commitId, submittedAt, login = "coderabbitai[bot]") {
  return { user: { login }, state, commit_id: commitId, submitted_at: submittedAt };
}

// The HTTP surface is where the signature gate is actually enforced, so these
// tests drive a real server through the real handler — only GitHub's reviews
// and check-run endpoints are faked.
function makeApi() {
  const calls = { reviews: [], created: [], updated: [] };
  const runs = [];
  let nextId = 100;
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    if (/\/pulls\/\d+\/reviews/.test(url)) {
      calls.reviews.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] };
    }
    if (/\/check-runs\?/.test(url) && method === "GET") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ check_runs: runs }) };
    if (/\/check-runs$/.test(url) && method === "POST") {
      calls.created.push(JSON.parse(opts.body));
      const id = nextId++;
      runs.push({ id, app: { id: APP_ID } });
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id }) };
    }
    if (/\/check-runs\/\d+$/.test(url) && method === "PATCH") {
      calls.updated.push(JSON.parse(opts.body));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 1 }) };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function pullRequestPayload() {
  return {
    action: "opened",
    number: 7,
    repository: { full_name: REPO },
    pull_request: { number: 7, head: { sha: HEAD }, user: { login: "octocat" } },
  };
}

function sign(body, secret = SECRET) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function withServer(handler, fn) {
  const server = createServer({ handler, log: QUIET });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    // fetch keeps sockets alive; without this, close() waits on them.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function appHandler(api, { getToken = async () => "tkn" } = {}) {
  return createHandler({ webhookSecret: SECRET, auth: { getToken }, appId: APP_ID, apiUrl: "https://api.github.com", fetchImpl: api.fetchImpl, log: QUIET });
}

test("GET /healthz answers 200 ok", async () => {
  await withServer(async () => ({ status: 202 }), async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });
});

test("a signed webhook delivery reaches the handler and publishes the check", async () => {
  const api = makeApi();
  await withServer(appHandler(api), async (base) => {
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sign(body) },
      body,
    });
    assert.equal(res.status, 202);
    // Two writes over the socket: the claim, then the completion.
    assert.equal(api.calls.created.length, 1);
    assert.equal(api.calls.created[0].status, "in_progress");
    assert.equal(api.calls.created[0].head_sha, HEAD);
    assert.equal(api.calls.updated.length, 1);
    assert.equal(api.calls.updated[0].conclusion, "success");
  });
});

// The security property, asserted over the socket rather than the handler
// alone: a delivery whose signature does not match never reaches GitHub, so
// nobody but the App can decide what the check says.
test("an unsigned or wrongly signed delivery is refused by the server and publishes nothing", async () => {
  const api = makeApi();
  await withServer(appHandler(api), async (base) => {
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));
    const forged = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sign(body, "not-the-secret") },
      body,
    });
    assert.equal(forged.status, 401);

    const unsigned = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body,
    });
    assert.equal(unsigned.status, 401);

    assert.equal(api.calls.reviews.length, 0);
    assert.equal(api.calls.created.length, 0);
    assert.equal(api.calls.updated.length, 0);
  });
});

test("a request to any other path or method is 404", async () => {
  await withServer(async () => ({ status: 202 }), async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/webhook?x=1`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/webhook`, { method: "GET" })).status, 404);
    assert.equal((await fetch(`${base}/healthz`, { method: "POST", body: "{}" })).status, 404);
  });
});

test("a handler that throws becomes 500, never a success", async () => {
  await withServer(async () => { throw new Error("boom"); }, async (base) => {
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-github-event": "pull_request" }, body: "{}" });
    assert.equal(res.status, 500);
  });
});

// The body cap exists so a hostile POST cannot make the process buffer without
// bound. Hitting it tears the connection down before a status can be written
// (the peer is still uploading), so what is pinned is the property that
// matters: the handler never runs, so nothing is fetched and no check exists.
test("a body past the size cap never reaches the handler", async () => {
  let handlerCalls = 0;
  const handler = async () => {
    handlerCalls += 1;
    return { status: 202 };
  };
  await withServer(handler, async (base) => {
    let status = null;
    try {
      const res = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "pull_request" },
        body: "x".repeat(6 * 1024 * 1024),
      });
      status = res.status;
      await res.text();
    } catch {
      // the refused connection is the same outcome, just observed differently
    }
    assert.notEqual(status, 202, "an oversized body must not be accepted as a delivery");
    assert.equal(handlerCalls, 0, "the handler must not run for an oversized body");
  });
});

test("a signed delivery that fails JSON parsing is a 400, not a crash", async () => {
  const api = makeApi();
  await withServer(appHandler(api), async (base) => {
    const body = Buffer.from("{not json");
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sign(body) },
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(api.calls.reviews.length, 0);
    assert.equal(api.calls.created.length, 0);
  });
});
