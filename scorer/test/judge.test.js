import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, readEvent, renderReport, progressBar } from "../src/judge.js";

const RUBRIC_DIR = fileURLToPath(new URL("./fixtures/rubric-judge/", import.meta.url));
const SCORER_DIR = fileURLToPath(new URL("../", import.meta.url));

// ---- Vendored copy of sync/src/parse.js (marker regex + GITHUB_LOGIN grammar
// + field validation). This pins the cross-repo contract: if sync's parser
// changes, this copy AND the judge's marker output must change together. ----
const MARKER = /<!--\s*ctf-score:\s*(\{[\s\S]*?\})\s*-->/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
function parseScoreComment(body, { targets }) {
  const m = MARKER.exec(body ?? "");
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const { author, target, solved } = data;
  if (typeof author !== "string" || !GITHUB_LOGIN.test(author)) return null;
  if (!targets.includes(target)) return null;
  if (!Array.isArray(solved) || solved.some((s) => typeof s !== "string")) return null;
  return {
    author,
    target,
    solved,
    pr: Number(data.pr ?? 0) || 0,
    sha: typeof data.sha === "string" ? data.sha : "",
  };
}
// ---- end vendored copy ----

// score-action's parsing regexes (contract 2 in the spec) — pinned verbatim.
const TITLE_RE = /^## 🏆 CTF Patch Score$/m;
const COUNT_RE = /\*\*(\d+)\s*\/\s*\d+\*\*\s+challenges patched/;
const NOT_RECORDED = "<!-- ctf-score:not-recorded -->";

const EVENT = {
  pull_request: { number: 7, user: { login: "octocat" }, head: { sha: "abc123" } },
};

function writeEvent(payload = EVENT) {
  const path = join(mkdtempSync(join(tmpdir(), "event-")), "event.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

// Mock target app satisfying xss-search + admin-panel but not still-vulnerable.
async function mockApp(t) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/REDACTED-search") return res.writeHead(200).end("clean results");
    if (path === "/REDACTED-admin" && req.method === "GET") return res.writeHead(401).end();
    if (path === "/REDACTED-admin/login" && req.method === "POST") {
      return res.writeHead(200).end("welcome REDACTED-INCLUDES");
    }
    if (path === "/REDACTED-debug") return res.writeHead(200).end("still here"); // expect 404 → fails
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function baseEnv(t, overrides = {}) {
  return {
    TARGET: "juice-shop",
    APP_URL: await mockApp(t),
    RUBRIC_DIR,
    GITHUB_WORKSPACE: mkdtempSync(join(tmpdir(), "workspace-")),
    GITHUB_EVENT_PATH: writeEvent(),
    APP_READY_TRIES: "3",
    APP_READY_DELAY: "0",
    ...overrides,
  };
}

const report = (env) => readFileSync(join(env.GITHUB_WORKSPACE, "ctf-score.md"), "utf8");

test("poll mode: pinned ctf-score.md format satisfies all three upstream regexes", async (t) => {
  const env = await baseEnv(t);
  const { solved, total } = await judge(env);
  assert.deepEqual(solved, ["xss-search", "admin-panel"]); // rubric order
  assert.equal(total, 3);

  const md = report(env);
  assert.match(md, TITLE_RE); // score-action title rewrite regex
  assert.equal(md.split("\n")[0], "## 🏆 CTF Patch Score"); // verbatim first line
  assert.equal(COUNT_RE.exec(md)?.[1], "2"); // score-action solve-count regex
  assert.match(md, /^<!-- ctf-score: \{.*\} -->$/m); // marker on its own line

  // Marker round-trips through the vendored sync/src/parse.js contract.
  assert.deepEqual(parseScoreComment(md, { targets: ["juice-shop"] }), {
    author: "octocat",
    target: "juice-shop",
    solved: ["xss-search", "admin-panel"],
    pr: 7,
    sha: "abc123",
  });

  // Redacted table: names, points, verdicts — nothing else.
  assert.match(md, /\| Search box no longer reflects HTML \| 10 \| ✅ Patched \|/);
  assert.match(md, /\| Admin panel requires auth \| 5 \| ✅ Patched \|/);
  assert.match(md, /\| Debug endpoint removed \| 1 \| ❌ Not yet \|/);
  assert.ok(!md.includes(NOT_RECORDED)); // no POST attempted in poll mode
});

test("oracle discipline: no probe path or expect string leaks into the report", async (t) => {
  const env = await baseEnv(t);
  await judge(env);
  const md = report(env);
  // Every probe path/header/body/expect value in the fixture carries this sentinel.
  assert.ok(!md.includes("REDACTED"), `report leaked probe detail:\n${md}`);
  // Belt and braces: assert against the fixture source itself.
  for (const line of readFileSync(join(RUBRIC_DIR, "juice-shop.yaml"), "utf8").split("\n")) {
    const m = /(?:path|bodyIncludes|bodyMissing|body):\s*"([^"]+)"/.exec(line);
    if (m) assert.ok(!md.includes(m[1]), `report leaked: ${m[1]}`);
  }
});

test("startup validation: missing TARGET/APP_URL, unknown target, no rubric", async (t) => {
  const env = await baseEnv(t);
  await assert.rejects(judge({ ...env, TARGET: undefined }), /TARGET is required/);
  await assert.rejects(judge({ ...env, APP_URL: undefined }), /APP_URL is required/);
  await assert.rejects(judge({ ...env, TARGET: "webgoat" }), /"webgoat" is not in the rubric/);
  await assert.rejects(judge({ ...env, RUBRIC_DIR: "/no/such/dir" }), /no rubric found/);
});

test("probe grammar is validated at judge startup, before any network call", async (t) => {
  // APP_URL points at a dead port: if validation ran later, we'd see the
  // readiness error instead of the grammar error.
  const env = await baseEnv(t, {
    RUBRIC_DIR: fileURLToPath(new URL("./fixtures/rubric-judge-bad-probe/", import.meta.url)),
    APP_URL: "http://127.0.0.1:1",
    APP_READY_TRIES: "1",
  });
  await assert.rejects(judge(env), /probe juice-shop\/xss-search\[0\]: unknown key: retry/);
});

test("event extraction: happy path and each missing field", async (t) => {
  assert.deepEqual(readEvent(writeEvent()), { author: "octocat", pr: 7, sha: "abc123" });
  assert.throws(() => readEvent("/no/such/event.json"), /event file not readable/);
  const badJson = writeEvent();
  writeFileSync(badJson, "{nope");
  assert.throws(() => readEvent(badJson), /not JSON/);
  assert.throws(() => readEvent(writeEvent({})), /no pull_request/);
  assert.throws(() => readEvent(writeEvent({ pull_request: { number: 7, head: { sha: "abc" } } })), /user\.login/);
  assert.throws(
    () => readEvent(writeEvent({ pull_request: { number: 7, user: { login: "-bad-" }, head: { sha: "abc" } } })),
    /fails the GitHub login grammar/,
  );
  assert.throws(() => readEvent(writeEvent({ pull_request: { user: { login: "octocat" }, head: { sha: "abc" } } })), /pull_request\.number/);
  assert.throws(() => readEvent(writeEvent({ pull_request: { number: 7, user: { login: "octocat" }, head: {} } })), /head\.sha/);
  // And through the judge itself:
  const env = await baseEnv(t, { GITHUB_EVENT_PATH: writeEvent({}) });
  await assert.rejects(judge(env), /no pull_request/);
});

test("readiness: unreachable APP_URL exits 1 through the real CLI", async (t) => {
  const env = await baseEnv(t, { APP_URL: "http://127.0.0.1:1", APP_READY_TRIES: "1", APP_READY_DELAY: "0" });
  await assert.rejects(judge(env), /never became reachable/);
  const { status, stderr } = spawnSync(process.execPath, ["src/index.js", "judge"], {
    cwd: SCORER_DIR,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(status, 1);
  assert.match(stderr, /never became reachable/);
});

// APP_READY_TRIES=0 is the bring-up's way of saying "I already proved this app
// ready by a stronger route than an HTTP GET". Security Shepherd's bring-up
// needs it: its certificate expired in 2019, and the alternative — exporting
// NODE_TLS_REJECT_UNAUTHORIZED=0 into the judge — would strip verification from
// every request the judge makes, not just this app's. So a judge told zero tries must
// score the app WITHOUT probing it, even when a probe would have failed outright.
test("readiness: APP_READY_TRIES=0 skips the probe instead of failing on it", async (t) => {
  const env = await baseEnv(t, { APP_READY_TRIES: "0", APP_READY_DELAY: "0" });
  const { total } = await judge(env, {
    fetchImpl: async () => { throw new Error("readiness probe must not run"); },
  });
  assert.ok(total >= 1);
});

// Push ingest is GONE (issue #377, ADR 56): the judge has no leaderboard POST
// hook left, so SCORE_API/SCORE_TOKEN in the environment must be inert. A
// fetchImpl that throws on any request to the would-be leaderboard is how this
// proves it — the readiness probe is skipped, and every probe this rubric runs
// goes to the mock app, so a POST to SCORE_API is the only thing that could
// reach it. The not-recorded marker had exactly one writer (that POST) and is
// therefore gone from every report too.
test("SCORE_API and SCORE_TOKEN are inert: the judge posts nothing anywhere", async (t) => {
  const { createServer } = await import("node:http");
  const hits = [];
  const api = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(202).end();
  });
  await new Promise((r) => api.listen(0, r));
  t.after(() => api.close());

  const env = await baseEnv(t, {
    SCORE_API: `http://127.0.0.1:${api.address().port}`,
    SCORE_TOKEN: "push-tok",
  });
  const { total } = await judge(env);
  assert.ok(total >= 1); // the run really happened — not a vacuous pass
  assert.ok(!report(env).includes(NOT_RECORDED));
  assert.deepEqual(hits, []);
});

test("renderReport pins column layout and JSON key order", () => {
  const md = renderReport({
    challenges: [{ id: "a", name: "A", points: 2 }],
    solved: [],
    author: "octocat",
    target: "juice-shop",
    pr: 7,
    sha: "abc123",
  });
  assert.match(md, /\| Challenge \| Points \| Result \|/);
  assert.match(md, /\*\*0 \/ 1\*\* challenges patched/);
  assert.ok(md.includes('<!-- ctf-score: {"author":"octocat","target":"juice-shop","solved":[],"pr":7,"sha":"abc123"} -->'));
});

test("renderReport shows a points-based progress bar", () => {
  // 3 of 4 points earned -> 75%; bar is 20 cells, round(0.75*20)=15 filled.
  const md = renderReport({
    challenges: [
      { id: "a", name: "A", points: 3 },
      { id: "b", name: "B", points: 1 },
    ],
    solved: ["a"],
    author: "octocat",
    target: "juice-shop",
    pr: 7,
    sha: "abc123",
  });
  assert.match(md, /`█{15}░{5}` \*\*75%\*\* — 3 \/ 4 pts/);
  assert.match(md, /\*\*1 \/ 2\*\* challenges patched/);
});

test("progressBar rounds and clamps to 20 cells", () => {
  assert.equal(progressBar(0), "░".repeat(20));
  assert.equal(progressBar(100), "█".repeat(20));
  assert.equal(progressBar(96), "█".repeat(19) + "░"); // round(19.2) = 19
  assert.equal(progressBar(50), "█".repeat(10) + "░".repeat(10));
  assert.equal(progressBar(150), "█".repeat(20)); // clamped
});

test("renderReport withholds the table when disclose is false but keeps counts and marker", () => {
  const md = renderReport({
    challenges: [{ id: "a", name: "A", points: 2 }],
    solved: ["a"],
    author: "octocat",
    target: "juice-shop",
    pr: 7,
    sha: "abc123",
    disclose: false,
  });
  // No per-challenge table…
  assert.doesNotMatch(md, /\| Challenge \| Points \| Result \|/);
  assert.match(md, /details are withheld/i);
  // …but the bar, the patched count, and the full solved marker still ship.
  assert.match(md, /\*\*100%\*\* — 2 \/ 2 pts/);
  assert.match(md, /\*\*1 \/ 1\*\* challenges patched/);
  assert.ok(md.includes('"solved":["a"]'));
});

test("judges an exec target and reports solved challenges by lowercased id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-exec-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(dir, "event.json"), JSON.stringify({
    pull_request: { user: { login: "octocat" }, number: 7, head: { sha: "deadbeef" } },
  }));

  const { solved, total } = await judge({
    TARGET: "vampi",
    APP_URL: "http://app.invalid",
    RUBRIC_DIR: join(import.meta.dirname, "fixtures", "rubric-exec"),
    GITHUB_WORKSPACE: workspace,
    GITHUB_EVENT_PATH: join(dir, "event.json"),
    APP_READY_TRIES: "1",
    APP_READY_DELAY: "0",
  }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });

  assert.equal(total, 1);
  assert.deepEqual(solved, ["challenge-1-ok"]);

  const report = readFileSync(join(workspace, "ctf-score.md"), "utf8");
  assert.match(report, /\*\*1 \/ 1\*\* challenges patched/);
  // Oracle discipline: no test file name, no assertion text.
  assert.doesNotMatch(report, /\.test\.js/);
});

// An aborted exec run is not a zero: the runner short-circuited challenges it
// never attempted, so publishing its `solved` would tell the contestant their
// patch achieved nothing AND (via the consumer workflow's cooldown) lock them
// out on the strength of a measurement that never happened. The judge must fail
// loudly instead, leaving no ctf-score.md — which is what makes the workflow
// render "❌ Scoring did not complete" with a link to the run.
test("an aborted exec run throws instead of writing a confident 0 / N", async () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-exec-abort-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(dir, "event.json"), JSON.stringify({
    pull_request: { user: { login: "octocat" }, number: 7, head: { sha: "deadbeef" } },
  }));

  await assert.rejects(
    judge({
      TARGET: "vampi",
      APP_URL: "http://app.invalid",
      RUBRIC_DIR: join(import.meta.dirname, "fixtures", "rubric-exec-unreachable"),
      GITHUB_WORKSPACE: workspace,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      APP_READY_TRIES: "1",
      APP_READY_DELAY: "0",
      // Two bare timeouts arm the abort; keep each one short.
      CTF_SCORE_SAFETY_MS: "400",
      CTF_SCORE_CONCURRENCY: "1",
    }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) }),
    /aborted before every challenge was scored/,
  );

  // The decisive assertion: no report at all, rather than a report saying 0 / 3.
  assert.equal(existsSync(join(workspace, "ctf-score.md")), false);
});

// Guards the cross-target hazard flagged by Task 3's review: a rubric dir
// holding BOTH a YAML target and an exec target must not throw when judging
// the YAML target. Before the fix, the validation loop called validateProbes
// unconditionally for every target's challenges, so an exec sibling's
// undefined `probes` broke judging of an unrelated declarative target. This
// must fail if the fix regresses to gating the skip on `target === TARGET`
// instead of on `c.exec` alone — a per-target guard would still validate the
// exec sibling's challenges whenever a DIFFERENT target is being judged.
test("judges a YAML target in a rubric dir that also holds an exec target sibling", async () => {
  const env = {
    TARGET: "juice-shop",
    APP_URL: "http://app.invalid",
    RUBRIC_DIR: fileURLToPath(new URL("./fixtures/rubric-mixed/", import.meta.url)),
    GITHUB_WORKSPACE: mkdtempSync(join(tmpdir(), "workspace-")),
    GITHUB_EVENT_PATH: writeEvent(),
    APP_READY_TRIES: "1",
    APP_READY_DELAY: "0",
  };

  const { solved, total } = await judge(env, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
  });

  assert.equal(total, 3);
  assert.deepEqual(solved, ["reflected-xss-search"]);
});

// #599: the report posts after the scoring window closes (or while paused) the
// same as during it, and its points read as counted when the event ignores
// them. Every report carries one line saying when points count; the marker,
// which is what the event actually ingests, is untouched.
test("renderReport says points count only while the scoring window is open", () => {
  const md = renderReport({
    challenges: [{ id: "c1", name: "One", points: 3 }],
    solved: ["c1"],
    author: "ada",
    target: "vampi",
    pr: 7,
    sha: "abc",
  });
  assert.match(md, /Points count only while the event's scoring window is open; see the event site for standings\./);
  assert.ok(md.indexOf("scoring window is open") < md.indexOf("<!-- ctf-score:"), "the line sits above the marker");
});
