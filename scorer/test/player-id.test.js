import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PLAYER_ID_RE } from "../src/player-id.js";

test("PLAYER_ID_RE accepts a minted v4 UUID", () => {
  assert.ok(PLAYER_ID_RE.test(randomUUID()));
});

test("PLAYER_ID_RE rejects logins, mixed-case ids and key-injection", () => {
  for (const bad of [
    "OctoCat",
    "0123456789abcdef0123456789ABCDEF",
    "ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345",
    `${randomUUID()}:x`,
    "",
  ]) {
    assert.equal(PLAYER_ID_RE.test(bad), false, bad);
  }
});
