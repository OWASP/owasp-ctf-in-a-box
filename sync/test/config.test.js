import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";

const APP_KEY_B64 = Buffer.from(
  crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey
).toString("base64");
const ENV = { GITHUB_ORG: "my-org", GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: APP_KEY_B64, SCORER_TOKEN: "s3cret" };

test("loads org and defaults from env", () => {
  const cfg = loadConfig(ENV);
  assert.equal(cfg.org, "my-org");
  assert.equal(cfg.apiUrl, "https://api.github.com");
  assert.equal(cfg.scorerUrl, "http://scorer:4000");
  assert.equal(cfg.commentAuthor, "github-actions[bot]");
  assert.equal(cfg.pollIntervalMs, 30000);
  assert.equal(cfg.statePath, "/state/state.json");
});

test("rejects a missing GITHUB_ORG, naming the key", () => {
  const { GITHUB_ORG, ...rest } = ENV;
  assert.throws(() => loadConfig(rest), /GITHUB_ORG is not set/);
});

test("rejects a blank GITHUB_ORG, naming the key", () => {
  assert.throws(() => loadConfig({ ...ENV, GITHUB_ORG: "" }), /GITHUB_ORG is not set/);
  assert.throws(() => loadConfig({ ...ENV, GITHUB_ORG: "   " }), /GITHUB_ORG is not set/);
});

test("trims GITHUB_ORG", () => {
  assert.equal(loadConfig({ ...ENV, GITHUB_ORG: "  my-org  " }).org, "my-org");
});

test("still requires SCORER_TOKEN", () => {
  const { SCORER_TOKEN, ...rest } = ENV;
  assert.throws(() => loadConfig(rest), /SCORER_TOKEN env var is required/);
});

test("ignores unknown env keys", () => {
  const cfg = loadConfig({ ...ENV, SOME_UNRELATED_KEY: "whatever", MODULES: "quiz,classic" });
  assert.equal(cfg.org, "my-org");
});

// loadConfig is pure over its argument: no reads of the live process.env
// beyond the default parameter value itself. A caller that passes an
// explicit env object must get an answer derived ONLY from that object.
test("is pure over the passed env, not the live process.env", () => {
  const realOrg = process.env.GITHUB_ORG;
  process.env.GITHUB_ORG = "leaked-from-process-env";
  try {
    assert.throws(() => loadConfig({ SCORER_TOKEN: "t" }), /GITHUB_ORG is not set/);
  } finally {
    if (realOrg === undefined) delete process.env.GITHUB_ORG;
    else process.env.GITHUB_ORG = realOrg;
  }
});

test("App creds yield a functional getToken", () => {
  const cfg = loadConfig(ENV);
  assert.equal(typeof cfg.getToken, "function");
});

test("rejects a non-PEM base64 private key", () => {
  const notPem = Buffer.from("not a pem").toString("base64");
  assert.throws(() => loadConfig({ ...ENV, GITHUB_APP_PRIVATE_KEY: notPem }), /PEM private key/);
});

test("throws when App creds are not set", () => {
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ...rest } = ENV;
  assert.throws(() => loadConfig(rest), /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required/);
});

// Number("abc") is NaN, and setTimeout(NaN) fires immediately — a typo'd
// interval would poll GitHub in a tight loop. Refuse at boot instead.
test("rejects a non-numeric or non-positive POLL_INTERVAL_MS instead of polling unthrottled", () => {
  assert.throws(() => loadConfig({ ...ENV, POLL_INTERVAL_MS: "abc" }), /POLL_INTERVAL_MS/);
  assert.throws(() => loadConfig({ ...ENV, POLL_INTERVAL_MS: "0" }), /POLL_INTERVAL_MS/);
  assert.equal(loadConfig({ ...ENV, POLL_INTERVAL_MS: "5000" }).pollIntervalMs, 5000);
});

// setTimeout caps at 2^31-1 ms and treats anything larger as 1 ms, and main()
// adds up to +20% jitter before sleeping — so the largest interval that stays a
// real timer after jitter is floor((2^31-1) / 1.2) = 1789569705.
test("bounds POLL_INTERVAL_MS so the jittered delay stays inside setTimeout's range", () => {
  assert.equal(loadConfig({ ...ENV, POLL_INTERVAL_MS: "1789569705" }).pollIntervalMs, 1789569705);
  assert.throws(() => loadConfig({ ...ENV, POLL_INTERVAL_MS: "1789569706" }), /POLL_INTERVAL_MS/);
});

test("honors STATE_PATH, SCORER_URL, COMMENT_AUTHOR, GITHUB_API_URL overrides", () => {
  const cfg = loadConfig({
    ...ENV,
    STATE_PATH: "/tmp/state.json",
    SCORER_URL: "http://scorer.internal:9000",
    COMMENT_AUTHOR: "custom-bot[bot]",
    GITHUB_API_URL: "https://ghe.example.com/api/v3",
  });
  assert.equal(cfg.statePath, "/tmp/state.json");
  assert.equal(cfg.scorerUrl, "http://scorer.internal:9000");
  assert.equal(cfg.commentAuthor, "custom-bot[bot]");
  assert.equal(cfg.apiUrl, "https://ghe.example.com/api/v3");
});

// Review (#479): GITHUB_ORG reaches the App auth, so an unset installation id
// resolves to the org's own installation.
test("the App auth discovers the installation for GITHUB_ORG", async () => {
  const cfg = loadConfig({ ...ENV, GITHUB_API_URL: "https://api.github.test" });
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/orgs/my-org/installation")) {
      return { ok: true, status: 200, json: async () => ({ id: 6, account: { login: "my-org" } }) };
    }
    if (String(url).endsWith("/app/installations")) {
      return { ok: true, status: 200, json: async () => [{ id: 5, account: { login: "someone-else" } }] };
    }
    return { ok: true, status: 201, json: async () => ({ token: "t", expires_at: "2033-11-14T00:00:00Z" }) };
  };
  assert.equal(await cfg.getToken(fetchImpl), "t");
  assert.ok(seen.some((u) => u.endsWith("/app/installations/6/access_tokens")));
});

// Review (#479): Number("abc") is NaN, and a NaN id went straight into
// /app/installations/NaN/access_tokens on every tick. Refuse it at start-up.
test("a non-numeric GITHUB_APP_INSTALLATION_ID is refused at start-up", () => {
  assert.throws(() => loadConfig({ ...ENV, GITHUB_APP_INSTALLATION_ID: "abc" }), /GITHUB_APP_INSTALLATION_ID must be a positive integer/);
  assert.throws(() => loadConfig({ ...ENV, GITHUB_APP_INSTALLATION_ID: "0" }), /GITHUB_APP_INSTALLATION_ID must be a positive integer/);
  assert.equal(typeof loadConfig({ ...ENV, GITHUB_APP_INSTALLATION_ID: "123" }).getToken, "function");
});

