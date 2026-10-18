import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifySignature } from "../src/verify.js";

const SECRET = "s3cret";
const BODY = Buffer.from(JSON.stringify({ hello: "world" }));
const sign = (body, secret = SECRET) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

test("a correctly signed body verifies", () => {
  assert.equal(verifySignature({ secret: SECRET, body: BODY, header: sign(BODY) }), true);
});

test("a body signed with another secret does not verify", () => {
  assert.equal(verifySignature({ secret: SECRET, body: BODY, header: sign(BODY, "other") }), false);
});

test("a tampered body does not verify", () => {
  assert.equal(verifySignature({ secret: SECRET, body: Buffer.from("{}"), header: sign(BODY) }), false);
});

test("a missing header does not verify", () => {
  assert.equal(verifySignature({ secret: SECRET, body: BODY, header: undefined }), false);
});

test("a header without the sha256= prefix does not verify", () => {
  assert.equal(verifySignature({ secret: SECRET, body: BODY, header: sign(BODY).replace("sha256=", "") }), false);
});

test("an empty secret does not verify", () => {
  assert.equal(verifySignature({ secret: "", body: BODY, header: sign(BODY) }), false);
});

test("a non-Buffer body does not verify", () => {
  assert.equal(verifySignature({ secret: SECRET, body: BODY.toString("utf8"), header: sign(BODY) }), false);
});
