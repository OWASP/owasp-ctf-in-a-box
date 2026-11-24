import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { validateProbes, runProbe, runProbes, waitForApp, joinUrl } from "../src/probe.js";

const probe = (request, expect) => [{ request, expect }];
const GET_OK = { method: "GET", path: "/ok" };

async function mockApp(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Routes exercised by the execution matrix. /hang never answers (timeouts).
function appRoutes(req, res) {
  const path = req.url.split("?")[0];
  if (path === "/ok" || path === "/WebGoat/ok") return res.writeHead(200).end("hello world");
  if (path === "/empty") return res.writeHead(204).end();
  if (path === "/teapot") return res.writeHead(418).end("short and stout");
  if (path === "/hang") return; // no response — probe timeout territory
  if (path === "/echo") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200).end(`probe=${req.headers["x-probe"] ?? ""} body=${body}`));
    return;
  }
  res.writeHead(404).end("nope");
}

test("valid probes pass validation (exact status, range, headers, body)", () => {
  validateProbes(
    [
      { request: GET_OK, expect: { status: 200 } },
      { request: { method: "POST", path: "/x", headers: { a: "b" }, body: "hi" }, expect: { status: [200, 299], bodyIncludes: "y", bodyMissing: "n" } },
    ],
    "t/c",
  );
});

test("probe validation failure matrix", () => {
  const bad = (probes, re) => assert.throws(() => validateProbes(probes, "t/c"), re);
  bad(["nope"], /probe t\/c\[0\]: expected a mapping/);
  bad([{ request: GET_OK, expect: { status: 200 }, retry: 3 }], /unknown key: retry/);
  bad([{ expect: { status: 200 } }], /request is required/);
  bad([{ request: GET_OK }], /expect is required/);
  bad(probe({ ...GET_OK, verb: "GET" }, { status: 200 }), /request: unknown key: verb/);
  bad(probe(GET_OK, { status: 200, bodyEquals: "x" }), /expect: unknown key: bodyEquals/);
  bad(probe({ method: "get", path: "/ok" }, { status: 200 }), /uppercase HTTP verb/);
  bad(probe({ method: "FETCH", path: "/ok" }, { status: 200 }), /uppercase HTTP verb/);
  bad(probe({ method: "GET", path: "ok" }, { status: 200 }), /must start with \//);
  bad(probe({ method: "GET" }, { status: 200 }), /must start with \//);
  bad(probe(GET_OK, {}), /status is required/);
  bad(probe(GET_OK, { status: "200" }), /status is required/);
  bad(probe(GET_OK, { status: [200] }), /\[min, max\]/);
  bad(probe(GET_OK, { status: [299, 200] }), /\[min, max\]/);
  bad(probe(GET_OK, { status: [200, "299"] }), /\[min, max\]/);
  bad(probe(GET_OK, { status: 200, bodyIncludes: 5 }), /bodyIncludes must be a string/);
  bad(probe({ ...GET_OK, headers: "x" }, { status: 200 }), /headers must be a mapping/);
  bad(probe({ ...GET_OK, headers: { a: 1 } }, { status: 200 }), /headers\.a must be a string/);
  bad(probe({ ...GET_OK, body: 5 }, { status: 200 }), /body must be a string/);
});

test("joinUrl never doubles a slash, even with an APP_URL path prefix", () => {
  assert.equal(joinUrl("http://app:8080", "/x"), "http://app:8080/x");
  assert.equal(joinUrl("http://app:8080/", "/x"), "http://app:8080/x");
  assert.equal(joinUrl("http://app:8080/WebGoat", "/x"), "http://app:8080/WebGoat/x");
  assert.equal(joinUrl("http://app:8080/WebGoat/", "/x"), "http://app:8080/WebGoat/x");
});

test("probe execution: status, range, bodyIncludes, bodyMissing", async (t) => {
  const app = await mockApp(t, appRoutes);
  const run = (request, expect) => runProbe(app, { request, expect });
  assert.equal(await run(GET_OK, { status: 200 }), true);
  assert.equal(await run(GET_OK, { status: 418 }), false);
  assert.equal(await run({ method: "GET", path: "/empty" }, { status: [200, 299] }), true);
  assert.equal(await run({ method: "GET", path: "/teapot" }, { status: [200, 299] }), false);
  assert.equal(await run(GET_OK, { status: 200, bodyIncludes: "hello" }), true);
  assert.equal(await run(GET_OK, { status: 200, bodyIncludes: "goodbye" }), false);
  assert.equal(await run(GET_OK, { status: 200, bodyMissing: "goodbye" }), true);
  assert.equal(await run(GET_OK, { status: 200, bodyMissing: "hello" }), false);
});

test("probe execution forwards headers and body", async (t) => {
  const app = await mockApp(t, appRoutes);
  const request = { method: "POST", path: "/echo", headers: { "x-probe": "abc" }, body: "payload" };
  assert.equal(await runProbe(app, { request, expect: { status: 200, bodyIncludes: "probe=abc body=payload" } }), true);
});

test("probe execution honors an APP_URL path prefix", async (t) => {
  const app = await mockApp(t, appRoutes);
  assert.equal(await runProbe(`${app}/WebGoat`, { request: GET_OK, expect: { status: 200 } }), true);
});

test("a challenge is solved iff ALL its probes pass", async (t) => {
  const app = await mockApp(t, appRoutes);
  const ok = { request: GET_OK, expect: { status: 200 } };
  const miss = { request: GET_OK, expect: { status: 500 } };
  assert.equal(await runProbes(app, [ok, ok]), true);
  assert.equal(await runProbes(app, [ok, miss]), false);
  assert.equal(await runProbes(app, [miss, ok]), false);
});

test("probe timeout and connection refusal fail the probe, not the run", async (t) => {
  const app = await mockApp(t, appRoutes);
  const hang = { request: { method: "GET", path: "/hang" }, expect: { status: 200 } };
  assert.equal(await runProbe(app, hang, { timeoutMs: 100 }), false);
  assert.equal(await runProbe("http://127.0.0.1:1", { request: GET_OK, expect: { status: 200 } }, { timeoutMs: 500 }), false);
});

test("waitForApp: an HTTP error is not readiness", async (t) => {
  const app = await mockApp(t, (req, res) => res.writeHead(500).end("boom"));
  assert.equal(await waitForApp(app, { tries: 1, delayMs: 0 }), false);
});

test("waitForApp: unreachable app exhausts its tries and reports down", async () => {
  assert.equal(await waitForApp("http://127.0.0.1:1", { tries: 1, delayMs: 0 }), false);
});

test("waitForApp retries until the app answers", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNREFUSED");
    return new Response("up");
  };
  assert.equal(await waitForApp("http://app", { tries: 5, delayMs: 0, fetchImpl: flaky }), true);
  assert.equal(calls, 3);
});
