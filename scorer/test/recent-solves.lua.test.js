// Executes RECENT_SCRIPT against a real Redis (redis-server + redis-cli),
// because the bug this guards against is invisible to a mock: the trim must
// read the evicted MEMBERS before ZREMRANGEBYRANK (which returns only a
// count), or the script errors and the data hash is never cleaned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECENT_SCRIPT, RECENT_SOLVES_MAX } from "../src/store.js";

function hasBinary(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_REDIS = hasBinary("redis-server") && hasBinary("redis-cli");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForRedis(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const pong = execFileSync("redis-cli", ["-p", String(port), "ping"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (pong === "PONG") return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("redis-server did not become ready");
}

const lines = (raw) => (raw ? raw.split("\n") : []);

test(
  "RECENT_SCRIPT executes and keeps the sorted set and data hash bounded and consistent",
  { skip: HAVE_REDIS ? false : "redis-server/redis-cli not installed" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "recent-lua-"));
    const scriptPath = join(dir, "recent.lua");
    writeFileSync(scriptPath, RECENT_SCRIPT);
    const port = await freePort();
    const proc = spawn(
      "redis-server",
      ["--port", String(port), "--save", "", "--appendonly", "no", "--dir", dir],
      { stdio: "ignore" },
    );
    t.after(() => {
      try {
        execFileSync("redis-cli", ["-p", String(port), "shutdown", "nosave"], { stdio: "ignore" });
      } catch {
        // already gone
      }
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    });
    await waitForRedis(port);

    const zset = "ctf:feed:test:zset";
    const data = "ctf:feed:test:data";
    const cli = (...args) =>
      execFileSync("redis-cli", ["-p", String(port), "--raw", ...args], { encoding: "utf8" }).trim();
    const write = (id, score, event, max) =>
      Number(cli("--eval", scriptPath, zset, data, ",", id, String(score), JSON.stringify(event), String(max)));

    // Under the cap: the script must succeed without trimming anything.
    assert.equal(write("under", 1000, { n: 1 }, RECENT_SOLVES_MAX), 1);
    assert.equal(cli("ZCARD", zset), "1");
    assert.equal(cli("HLEN", data), "1");

    // Replays stay no-ops: no new member, no moved score, no rewritten row.
    assert.equal(write("under", 2000, { n: 2 }, RECENT_SOLVES_MAX), 0);
    assert.equal(cli("ZSCORE", zset, "under"), "1000");
    assert.deepEqual(JSON.parse(cli("HGET", data, "under")), { n: 1 });
    assert.equal(cli("ZCARD", zset), "1");
    assert.equal(cli("HLEN", data), "1");

    // Over the cap: the oldest lines leave both keys together.
    for (let i = 0; i < 8; i++) {
      assert.equal(write(`trim:${i}`, 1000 + i, { n: i }, 5), 1);
    }
    const kept = ["trim:3", "trim:4", "trim:5", "trim:6", "trim:7"];
    assert.equal(cli("ZCARD", zset), "5");
    assert.equal(cli("HLEN", data), "5");
    assert.deepEqual(lines(cli("ZRANGE", zset, "0", "-1")), kept);
    assert.deepEqual(lines(cli("HKEYS", data)).sort(), kept);
    assert.deepEqual(JSON.parse(cli("HGET", data, "trim:7")), { n: 7 });

    // The production cap keeps exactly the newest 50, hash included.
    cli("DEL", zset, data);
    for (let i = 0; i < 55; i++) {
      assert.equal(write(`max:${i}`, 1000 + i, { n: i }, RECENT_SOLVES_MAX), 1);
    }
    const newest = Array.from({ length: RECENT_SOLVES_MAX }, (_, i) => `max:${i + 5}`);
    assert.equal(cli("ZCARD", zset), String(RECENT_SOLVES_MAX));
    assert.equal(cli("HLEN", data), String(RECENT_SOLVES_MAX));
    assert.deepEqual(lines(cli("ZRANGE", zset, "0", "-1")), newest);
    assert.deepEqual(lines(cli("HKEYS", data)).sort(), [...newest].sort());
    assert.deepEqual(JSON.parse(cli("HGET", data, "max:54")), { n: 54 });
  },
);
