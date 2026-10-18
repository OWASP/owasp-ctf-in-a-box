import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";

const PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const B64 = Buffer.from(PEM, "utf8").toString("base64");

function env(overrides = {}) {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: B64,
    GITHUB_WEBHOOK_SECRET: "hook-secret",
    GITHUB_APP_INSTALLATION_ID: "42",
    ...overrides,
  };
}

// A config that cannot be trusted must refuse to be built: a gate running with
// a defaulted or half-read key would publish a check it cannot defend.
test("both App credentials are required", () => {
  assert.throws(() => loadConfig(env({ GITHUB_APP_ID: undefined })), /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/);
  assert.throws(() => loadConfig(env({ GITHUB_APP_PRIVATE_KEY: undefined })), /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/);
});

test("the private key must be base64-encoded PEM", () => {
  assert.throws(() => loadConfig(env({ GITHUB_APP_PRIVATE_KEY: "not-a-key" })), /base64-encoded PEM/);
  assert.throws(() => loadConfig(env({ GITHUB_APP_PRIVATE_KEY: Buffer.from("no private key here").toString("base64") })), /base64-encoded PEM/);
});

test("a webhook secret is required", () => {
  assert.throws(() => loadConfig(env({ GITHUB_WEBHOOK_SECRET: undefined })), /GITHUB_WEBHOOK_SECRET/);
});

test("the installation id, when set, is a positive integer", () => {
  assert.throws(() => loadConfig(env({ GITHUB_APP_INSTALLATION_ID: "abc" })), /GITHUB_APP_INSTALLATION_ID/);
  assert.throws(() => loadConfig(env({ GITHUB_APP_INSTALLATION_ID: "-1" })), /GITHUB_APP_INSTALLATION_ID/);
  assert.throws(() => loadConfig(env({ GITHUB_APP_INSTALLATION_ID: "1.5" })), /GITHUB_APP_INSTALLATION_ID/);
});

test("a valid environment yields the signer and the webhook secret", async () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.appId, "12345");
  assert.equal(cfg.webhookSecret, "hook-secret");
  assert.equal(typeof cfg.auth.getToken, "function");

  // The wiring produces a working installation-token signer, proven against a
  // faked GitHub rather than the network.
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method ?? "GET"} ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: "inst-token", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    };
  };
  assert.equal(await cfg.auth.getToken(fetchImpl), "inst-token");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^POST https:\/\/api\.github\.com\/app\/installations\/42\/access_tokens$/);
});

test("an omitted installation id is discovered from GitHub, not guessed", async () => {
  const cfg = loadConfig(env({ GITHUB_APP_INSTALLATION_ID: undefined }));
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method ?? "GET"} ${url}`);
    if ((opts.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => [{ id: 7, account: { login: "owasp" } }] };
    }
    return {
      ok: true,
      status: 201,
      json: async () => ({ token: "discovered-token", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    };
  };

  // The token proves the whole path: the App JWT listed the installations,
  // the sole installation (id 7) was used, and its token came back.
  assert.equal(await cfg.auth.getToken(fetchImpl), "discovered-token");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^GET https:\/\/api\.github\.com\/app\/installations$/);
  assert.match(calls[1], /^POST https:\/\/api\.github\.com\/app\/installations\/7\/access_tokens$/);
});
