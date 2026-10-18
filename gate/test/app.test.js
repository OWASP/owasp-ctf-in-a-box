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
function makeApi({ reviewPages = {}, listRuns = [], reviewsStatus = 200, failCompletedWrite = false } = {}) {
  const calls = { reviews: [], created: [], updated: [] };
  // Like GitHub's list endpoint, a run this fake creates is visible to the
  // next list call — the claim write is what the completion write then finds.
  const runs = listRuns.map((r) => ({ ...r }));
  let nextId = 100;
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
      return jsonResponse({ check_runs: runs });
    }
    if (/\/check-runs$/.test(url) && method === "POST") {
      calls.created.push(JSON.parse(opts.body));
      const id = nextId++;
      runs.push({ id, app: { id: APP_ID } });
      return jsonResponse({ id }, { status: 201 });
    }
    if (/\/check-runs\/\d+$/.test(url) && method === "PATCH") {
      const body = JSON.parse(opts.body);
      // Only a 2xx write changes the run, so only a 2xx write is recorded —
      // what GitHub holds afterwards is what the assertions describe.
      if (failCompletedWrite && body.status === "completed") return jsonResponse({ message: "boom" }, { status: 500 });
      calls.updated.push(body);
      return jsonResponse({ id: 1 });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

// A delivery writes the check twice: the claim (in_progress, before the
// verdict is read) and the completion. These pull each out of whichever write
// recorded it — created when the run was new, updated when it already existed.
function claimed(api) {
  return [...api.calls.created, ...api.calls.updated].find((b) => b.status === "in_progress");
}

function completed(api) {
  return [...api.calls.created, ...api.calls.updated].find((b) => b.status === "completed");
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
  assert.equal(claimed(api).name, "coderabbit-approved");
  assert.equal(claimed(api).head_sha, HEAD);
  assert.equal(completed(api).conclusion, "success");
  assert.equal(completed(api).head_sha, HEAD);
});

test("a newer CHANGES_REQUESTED on the head publishes a failure", async () => {
  const api = makeApi({
    reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z"), rev("CHANGES_REQUESTED", HEAD, "2026-01-02T00:00:00Z")] },
  });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request_review", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(completed(api).conclusion, "failure");
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
  // The claim landed before the read, so this head's row was already out of
  // any earlier conclusion by the time the read failed.
  assert.equal(claimed(api).status, "in_progress");
  assert.equal(completed(api).conclusion, "failure");
});

test("a failure to mint a token returns 500 and publishes nothing", async () => {
  const api = makeApi({ reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] } });
  const handler = makeHandler(api.fetchImpl, { getToken: async () => { throw new Error("no key"); } });
  const res = await deliver(handler, { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 500);
  assert.equal(api.calls.created.length, 0);
  assert.equal(api.calls.updated.length, 0);
});

test("Dependabot publishes success without reading reviews", async () => {
  const api = makeApi();
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload({ author: "dependabot[bot]" }) });
  assert.equal(res.status, 202);
  assert.equal(api.calls.reviews.length, 0);
  assert.equal(completed(api).conclusion, "success");
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
  assert.equal(completed(api).conclusion, "success");
});

test("a stale approval on another commit publishes a failure", async () => {
  const api = makeApi({ reviewPages: { 1: [rev("APPROVED", OTHER, "2026-01-01T00:00:00Z")] } });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(completed(api).conclusion, "failure");
});

test("an existing run by this app is updated, not re-created", async () => {
  const api = makeApi({
    reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] },
    listRuns: [{ id: 99, app: { id: APP_ID } }],
  });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.equal(api.calls.created.length, 0);
  assert.equal(api.calls.updated.length, 2);
  assert.equal(api.calls.updated[0].status, "in_progress");
  assert.equal(api.calls.updated[1].conclusion, "success");
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

// A run that already said success on this head must not survive a delivery
// that then fails to publish: the claim moves it to in_progress first, so the
// only write that lands is an unfinished check — never a conclusion. GitHub
// does not automatically redeliver the failed delivery, so nothing later
// would come to correct a stale success by itself.
test("a failed completion write leaves the claim, never an earlier success", async () => {
  const api = makeApi({
    reviewPages: { 1: [rev("APPROVED", HEAD, "2026-01-01T00:00:00Z")] },
    listRuns: [{ id: 99, app: { id: APP_ID } }],
    failCompletedWrite: true,
  });
  const res = await deliver(makeHandler(api.fetchImpl), { event: "pull_request_review", payload: pullRequestPayload() });
  assert.equal(res.status, 500);
  assert.equal(api.calls.updated.length, 1);
  assert.equal(api.calls.updated[0].status, "in_progress");
  assert.equal([...api.calls.created, ...api.calls.updated].some((b) => b.conclusion === "success"), false);
});

// Beyond the page cap the review set is incomplete, and the newest verdict can
// be on a page never read. The truncated set must never be judged — the read
// throws and the handler publishes a failure instead.
test("more review pages than the cap fails closed instead of judging a truncated set", async () => {
  const reviewPages = {};
  for (let i = 1; i <= 21; i++) reviewPages[i] = [rev("APPROVED", HEAD, `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`)];
  const api = makeApi({ reviewPages });
  await assert.rejects(
    fetchAllReviews({ apiUrl: API, token: "tkn", repo: REPO, number: 7, fetchImpl: api.fetchImpl }),
    /more than 20 review pages/,
  );

  const handlerApi = makeApi({ reviewPages });
  const res = await deliver(makeHandler(handlerApi.fetchImpl), { event: "pull_request", payload: pullRequestPayload() });
  assert.equal(res.status, 202);
  assert.match(completed(handlerApi).output.summary, /more than 20 review pages/);
  assert.equal(completed(handlerApi).conclusion, "failure");
});
