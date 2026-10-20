import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// VAmPI's /createdb commits its seed users one at a time (name1, then name2,
// then admin), so a stock box can be caught with name1 present and name2 not
// yet. In that window the stock app answers Challenge 6's PUT
// /users/v1/name2/password with 400 "User Not Found"; the attacker-set
// password then fails to log in, and a test that only checks that login
// passes on the STOCK app (#661). This fake holds the box in that window.

const C6 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../rubric.owasp/vampi/tests/challenges/Challenge-6-Unauthorized-Password-Change.test.js",
);

function startMidSeedVampi() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && (req.url === "/" || req.url === "/createdb")) return json(200, {});
      if (req.method === "GET" && req.url === "/users/v1/_debug") {
        return json(200, { users: [{ username: "name1" }, { username: "name2" }, { username: "admin" }] });
      }
      if (req.method === "POST" && req.url === "/users/v1/login") {
        const { username, password } = JSON.parse(body || "{}");
        if (username === "name1" && password === "pass1") return json(200, { auth_token: "t-name1" });
        return json(200, { status: "fail", message: "Username does not exist" });
      }
      if (req.method === "PUT" && req.url === "/users/v1/name2/password") {
        return json(400, { status: "fail", message: "User Not Found" });
      }
      return json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Same env scrub as src/exec.js: a child `node --test` that inherits the
// parent runner's NODE_TEST_CONTEXT skips its files and exits 0.
function runChallenge(url) {
  const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _wid, ...env } = process.env;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", C6], {
      env: { ...env, VAMPI_URL: url },
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("VAmPI Challenge 6 does not pass when the victim account does not exist yet", async () => {
  const vampi = await startMidSeedVampi();
  try {
    const { code, out } = await runChallenge(vampi.url);
    assert.match(out, /Challenge-6-Unauthorized-Password-Change/, `Challenge 6 never ran:\n${out}`);
    assert.notEqual(code, 0, `Challenge 6 passed on a box where name2 was never seeded:\n${out}`);
  } finally {
    await vampi.close();
  }
});
