import crypto from "node:crypto";

// GitHub signs every App webhook body with the App's webhook secret and
// sends the HMAC-SHA256 as `X-Hub-Signature-256: sha256=<hex>`. This is the
// only thing that proves a delivery came from GitHub rather than from a
// contestant posting to the public endpoint, so it runs BEFORE the body is
// parsed and fails closed on anything but an exact, constant-time match.
//
// `body` is the raw request bytes (a Buffer), never a re-serialized object:
// re-serializing changes whitespace and the HMAC would never match.
export function verifySignature({ secret, body, header }) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  if (!Buffer.isBuffer(body)) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  const got = Buffer.from(header, "utf8");
  const want = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, and the length is not secret,
  // so compare it first and only reach the constant-time compare on equal length.
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
