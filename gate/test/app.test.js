import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHandler, fetchAllReviews } from "../src/app.js";

const SECRET = "webhook-secret";
const APP_ID = 12345;
const API = "https://api.github.com";
const REPO = "example/repo";
const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";
const QUIET = { warn() {}, error() {}, info() {} };

function rev(state, commitId, submittedAt, login = "coderabbitai[bot]") {
  return { user: { login }, state, commit_id: commitId, submitted_at: submittedAt };
}

function jsonResponse(data, { link = null, status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "link" ? link : null) },
    json: async () => data,
  };
}

// A fake GitHub API that serves paginated reviews and the check-run endpoints,
// recording every call so a test can assert what was — and was not — touched.
function makeApi({ reviewPages = {}, listRuns = [], reviewsStatus = 200 } = {}) {
  const calls = { reviews: [], created: [], updated: [] };
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    if (/\/pulls\/\d+\/reviews/.test(url)) {
      calls.reviews.push(url);
      if (reviewsStatus !== 200) return jsonResponse({ message: "boom" }, { status: reviewsStatus });
      const u = new URL(url);
      const page = Number(u.searchParams.get("page") ?? "1");
      const items = reviewPages[page] ?? [];
      let link = null;
      if (reviewPages[page + 1]) {
        u.searchParams.set("page", String(page + 1));
        link = `<${u.toString()}>; rel="next"`;
      }
      return jsonResponse(items, { link });
    }
    if (/\/check-runs\?/.test(url) && method === "GET") {
      return jsonResponse({ check_runs: listRuns });
    }
    if (/\/check-runs$/.test(url) && method === "POST") {
      calls.created.push(JSON.parse(opts.body));
      return jsonResponse({ id: 1 }, { status: 201 });
    }
    if (/\/check-runs\/\d+$/.test(url) && method === "PATCH") {
      calls.updated.push(JSON.parse(opts.body));
      return jsonResponse({ id: 1 });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function makeHandler(fetchImpl, { getToken = async () => "tkn" } = {}) {
  return createHandler({ webhookSecret: SECRET, auth: { getToken }, appId: APP_ID, apiUrl: API, fetchImpl, log: QUIET });
}

function pullRequestPayload({ action = "opened", author = "octocat", headSha = HEAD, number = 7 } = {}) {
  return {
    action,
    number,
    repository: { full_name: REPO },
    pull_request: { number, head: { sha: headSha }, user: { login: author } },
  };
}

function deliver(handle, { event, payload, secret = SECRET }) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  return handle({ event, headers: { "x-hub-signature-256": header }, body });
}

test("an approval on the head publishes a success check", async () => {
  const api = makeApi({ reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] } });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.created.length, 1);
  assert.equal(api.calls.created[0].name, "coderabbit-approved");
  assert.equal(api.calls.created[0].conclusion, "success");
  assert.equal(api.calls.created[0].head_sha, HEAD);
});

test("a newer CHANGES_REQUESTED on the head publishes a failure", async () => {
  const api = makeApi({
    reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z"), rev("CHANGES_REQUESTED", HEAD, "2026-01-02T00:00:00Z")] },
  });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request_review", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.created[0].conclusion, "failure");
});

// The regression the App-owned check exists for: a delivery not signed by the
// App's webhook secret must publish nothing. A contestant can POST whatever
// they like to the public endpoint; the signature is what stops them.
test("a forged delivery is refused and publishes no check", async () => {
  const api = makeApi({ reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] } });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload(), secret: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(api.calls.reviews.length, 0);
  assert.equal(api.calls.created.length, 0);
  assert.equal(api.calls.updated.length, 0);
});

test("a delivery with no signature header is refused", async () => {
  const api = makeApi();
  const body = Buffer.from(JSON.stringify(pullRequestPayload()));
  const res = await makeHandler(api.fetchImpl)({ event: "pull_request", headers: {}, body });
  assert.equal(res.status, 401);
  assert.equal(api.calls.created.length, 0);
});

test("an unrelated event is ignored and publishes nothing", async () => {
  const api = makeApi();
  const res = await deliver(makeHandler(api.fetchImpl), { event: "issues", payload: pullRequestPayload() });
  assert.equal(res.status, 204);
  assert.equal(api.calls.created.length, 0);
  assert.equal(api.calls.reviews.length, 0);
});

test("a pull_request action that cannot move the verdict is ignored", async () => {
  const api = makeApi();
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload({ action: "labeled" }) });
  assert.equal(res.status, 204);
  assert.equal(api.calls.created.length, 0);
});

test("a failure to read reviews publishes a failing check (fails closed)", async () => {
  const api = makeApi({ reviewsStatus: 500 });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.created.length, 1);
  assert.equal(api.calls.created[0].conclusion, "failure");
});

test("a failure to mint a token returns 500 and publishes nothing", async () => {
  const api = makeApi({ reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] } });
  const handler = makeHandler(api.fetchImpl, { getToken: async () => { throw new Error("no key"); } });
  const res = await deliver(handler, { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 500);
  assert.equal(api.calls.created.length, 0);
});

test("Dependabot publishes success without reading reviews", async () => {
  const api = makeApi();
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload({ author: "dependabot[bot]" }) });
  assert.equal(res.status, 202);
  assert.equal(api.calls.reviews.length, 0);
  assert.equal(api.calls.created[0].conclusion, "success");
});

test("the newest verdict wins across pages", async () => {
  const api = makeApi({
    reviewPages: {
      1: [rev("CHANGES_REQUESTED", HEAD, "2026-01-01T00:00:00Z")],
      2: [rev("APPROVED", HEAD, "2026-01-02T00:00:00Z")],
    },
  });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request_review", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.created[0].conclusion, "success");
});

test("a stale approval on another commit publishes a failure", async () => {
  const api = makeApi({ reviewPages: { 1: [rev("APPROVED", OTHER, "2026-01-01T00:00:00Z")] } });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.created[0].conclusion, "failure");
});

test("an existing run by this app is updated, not re-created", async () => {
  const api = makeApi({
    reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] },
    listRuns: [{ id: 99, app: { id: APP_ID } }],
  });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.updated.length, 1);
  assert.equal(api.calls.updated[0].conclusion, "success");
  assert.equal(api.calls.created.length, 0);
});

test("fetchAllReviews follows the Link header to the last page", async () => {
  const api = makeApi({
    reviewPages: {
      1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")],
      2: [rev("APPROVED", HEAD, "2026-01-02T00:00:00Z")],
      3: [rev("APPROVED", HEAD, "2026-01-03T00:00:00Z")],
    },
  });
  const reviews = await fetchAllReviews({ apiUrl: API, token: "tkn", repo: REPO, number: 7, fetchImpl: api.fetchImpl });
  assert.equal(reviews.length, 3);
  assert.equal(api.calls.reviews.length, 3);
});
