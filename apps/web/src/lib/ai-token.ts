// The ai module's identity boundary. TWO signatures live here, and they are
// deliberately NOT the same kind of thing:
//
//   - The LAUNCH TOKEN is an EdDSA (Ed25519) JWS, signed with a MODULE-WIDE
//     private key the box alone holds. Its public half is publishable, so a
//     key-holding backend AND a pure static SPA can both VERIFY who is playing,
//     while neither can MINT. Identity is the one thing the box owns.
//   - The EVENT SIGNATURE is an HMAC over the request body, keyed by the
//     PER-CHALLENGE symmetric key from `ctf:ai:signkey`. It proves the sender is
//     the backend the organizer configured, and nothing else.
//
// They used to share one symmetric key, and that was a real hole: with an HMAC,
// verify-power IS mint-power. A backend holding the event key could mint a
// launch token naming any `sub`, and a caller that trusted `claims.sub` would
// award points to a user who never opened the challenge. Splitting the two —
// asymmetric for launch, symmetric for events — is what makes the threat note
// true: a leaked event key proves the sender and can invent nobody. See ADR 53.
//
// `verifyLaunchToken` NEVER reads the header's `alg` to pick an algorithm. It
// verifies Ed25519 or it fails, and it refuses a key that is not an Ed25519 key
// at all. Algorithm confusion is the exact class of bug this split exists to
// close, and re-introducing an `alg` switch would re-open it.
//
// Not `server-only`: this file is pure crypto over `node:crypto` with no store
// access, and the admin test route needs it. It must never import the store.
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import { AI_EVENT_SKEW_SEC } from "@/lib/ai-defaults";

export const AI_KEY_PREFIX = "aik_";

/** A fresh per-challenge EVENT signing key. 32 bytes of CSPRNG output — this
 *  one is a real secret (unlike a challenge id), so `Math.random` is not an
 *  option.
 *
 *  This key signs EVENTS ONLY. It cannot mint a launch token; that is the
 *  entire point of the split above. */
export function generateSigningKey(): string {
  return `${AI_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The module-wide launch keypair, PEM-encoded.
 *
 *  `privateKey` is SECRET and box-only — it belongs to the same secrecy
 *  boundary as `ctf:ai:flag` and `ctf:ai:signkey`, and leaking it lets its
 *  holder mint a launch token naming ANY user, which is the one power no
 *  external party may have. `publicKey` is PUBLIC BY DESIGN: publishing it is
 *  what lets a static SPA verify a token it was handed. */
export type AiLaunchKeyPair = { publicKey: string; privateKey: string };

/** Mints a module-wide Ed25519 keypair. ONE pair for the whole module, not one
 *  per challenge: `aud` already scopes a token to a single challenge, and one
 *  publishable public key is far simpler for an integrator than N of them. */
export function generateLaunchKeyPair(): AiLaunchKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export type AiTokenProgress = {
  id: string;
  points: number;
  solved: boolean;
  solvedAt: string | null;
};

export type AiTokenClaims = {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  ctf: {
    module: "ai";
    challenge: { id: string; title: string; points: number };
    points: number;
    progress: AiTokenProgress[];
    /** Present only when `progress` was capped at AI_PROGRESS_MAX. */
    truncated?: true;
    /** Present only on a token minted for an admin PREVIEW (#464: before
     *  launch). The box grades anything it carries as a dry run; an external
     *  site must not treat it as a real player. Signed like every claim, so it
     *  cannot be added to a contestant's token. */
    preview?: true;
  };
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function hmac(key: string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Refuses missing or empty key material, and THROWS rather than returning a
 *  falsy verdict.
 *
 *  `createHmac('sha256', '')` does not throw — it happily produces a valid
 *  digest over the empty key, which anyone can guess. A signature made that way
 *  verifies, so an empty key would let anyone forge one.
 *  `AdminAiChallenge.signingKey` is `""` for a legacy row that was written
 *  before its key was minted, so this is a value that really can reach here.
 *
 *  A throw, not `false`: a caller with no key has a BUG, and reporting it as
 *  "bad signature" would hide it behind a refusal that looks routine. */
function requireKeyMaterial(key: string, label: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`ai-token: a non-empty ${label} is required (an empty key produces a forgeable token)`);
  }
}

function requireKey(key: string): void {
  requireKeyMaterial(key, "signing key");
}

/** Constant-time compare that tolerates a length mismatch. `timingSafeEqual`
 *  THROWS on differing lengths, so a truncated signature would surface as a
 *  500 instead of a refusal — and the length itself is not a secret. */
function equalBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The ONLY asymmetric algorithm this module will sign or verify with. Both
 *  paths assert it against the KEY, never against the token's own header — a
 *  header is attacker-controlled and a key is not. */
const LAUNCH_KEY_TYPE = "ed25519";

function requireEd25519(key: KeyObject, label: string): KeyObject {
  if (key.asymmetricKeyType !== LAUNCH_KEY_TYPE) {
    throw new Error(`ai-token: the launch ${label} must be an Ed25519 key, got ${String(key.asymmetricKeyType)}`);
  }
  return key;
}

function keyIdFor(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url").slice(0, 16);
}

/** A stable, non-secret identifier for a launch keypair: a truncated SHA-256
 *  thumbprint of the SPKI public key. Stable for the life of one keypair and
 *  different after a rotation, which is what a future JWKS-style route wants.
 *
 *  It is a LABEL, never an input to a trust decision — `verifyLaunchToken`
 *  ignores the `kid` in a token entirely, because the module has exactly one
 *  launch key and letting a token name the key that checks it is how key
 *  confusion starts. */
export function launchKeyId(publicKeyPem: string): string {
  requireKeyMaterial(publicKeyPem, "launch public key");
  return keyIdFor(requireEd25519(createPublicKey(publicKeyPem), "public key"));
}

/** Mints a launch token. Signing needs the PRIVATE key, which only the box has
 *  — there is no argument to this function that an external party could hold. */
export function signLaunchToken(claims: AiTokenClaims, privateKeyPem: string): string {
  requireKeyMaterial(privateKeyPem, "launch private key");
  // Passing the PUBLIC pem here throws out of `createPrivateKey`, which is the
  // correct answer: a public key must never be able to mint.
  const privateKey = requireEd25519(createPrivateKey(privateKeyPem), "private key");
  const header = { alg: "EdDSA", typ: "JWT", kid: keyIdFor(createPublicKey(privateKey)) };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  // `null` as the digest is how `node:crypto` says "the algorithm is the key's
  // own" — Ed25519 hashes internally and rejects an explicit digest.
  const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

export type AiTokenCheck =
  | { ok: true; claims: AiTokenClaims }
  | { ok: false; error: "malformed" | "invalid-signature" | "expired" | "audience" };

/** Verifies a launch token against the module's launch PUBLIC key.
 *
 *  `audience` is REQUIRED, in the type and again at runtime. These tokens are
 *  checked on unauthenticated, cookie-blind routes, where an omitted audience
 *  would silently accept a token minted for a DIFFERENT challenge — a token the
 *  contestant legitimately holds, aimed at a challenge they have not opened. A
 *  missing audience therefore fails CLOSED with `audience` rather than throwing:
 *  it refuses every token, which is loud, local and harmless, where an accepted
 *  one is none of those. It is checked first because it is a fact about the
 *  CALLER's own argument and so leaks nothing about the token.
 *
 *  After that, order matters: signature, then expiry, then audience match.
 *  Reporting "expired" for a token we cannot authenticate would answer a
 *  question the caller has not earned an answer to.
 *
 *  The token's header is not consulted at all. Ed25519 is hard-coded and
 *  asserted against the key, so a token claiming `alg: "none"`, `alg: "HS256"`
 *  or any other value is simply a token whose signature does not verify. */
export function verifyLaunchToken(
  token: string,
  publicKeyPem: string,
  opts: { audience: string; nowSec?: number },
): AiTokenCheck {
  requireKeyMaterial(publicKeyPem, "launch public key");
  const audience = opts?.audience;
  if (typeof audience !== "string" || audience.length === 0) return { ok: false, error: "audience" };

  if (typeof token !== "string") return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { ok: false, error: "malformed" };

  // Throws on junk key material — a caller bug, not a bad token. A SYMMETRIC
  // key (the per-challenge event key) lands here and throws too, which is
  // exactly right: it is not a launch key and must never be treated as one.
  const publicKey = requireEd25519(createPublicKey(publicKeyPem), "public key");

  let authentic = false;
  try {
    authentic = cryptoVerify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    // A malformed signature blob is a refusal, never a 500.
    authentic = false;
  }
  if (!authentic) return { ok: false, error: "invalid-signature" };

  const claims = decodeClaims(parts[1]);
  if (!claims) return { ok: false, error: "malformed" };

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSec) return { ok: false, error: "expired" };
  if (claims.aud !== audience) return { ok: false, error: "audience" };

  return { ok: true, claims };
}

/** What a static SPA that has NOT fetched the public key can do: read the
 *  payload, trust nothing. Never call this on a path that awards anything.
 *
 *  A SPA that HAS the public key should call `verifyLaunchToken` instead — that
 *  is what publishing the public half buys. */
export function decodeTokenUnverified(token: string): AiTokenClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return decodeClaims(parts[1]);
}

function decodeClaims(segment: string): AiTokenClaims | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c.sub !== "string" || typeof c.aud !== "string" || typeof c.jti !== "string") return null;
    if (typeof c.iat !== "number" || typeof c.exp !== "number") return null;
    return parsed as AiTokenClaims;
  } catch {
    return null;
  }
}

/** The signature an external backend puts on a solve event: HMAC over
 *  `<timestamp>.<raw body>`, keyed by the PER-CHALLENGE symmetric key. The
 *  timestamp is INSIDE the signed material, so a captured request cannot be
 *  replayed later under a fresh header.
 *
 *  Symmetric on purpose, and safe to keep symmetric: the holder of this key can
 *  prove it sent a request, and that is the whole of what the key means.
 *  Naming the user is the launch token's job, and that token is signed with a
 *  key this side does not have. */
export function signEventBody(key: string, tsSec: number, rawBody: string): string {
  requireKey(key);
  return `sha256=${hmac(key, `${tsSec}.${rawBody}`).toString("hex")}`;
}

/** `rawBody` MUST be the exact bytes received. Re-serializing a parsed body
 *  before hashing changes whitespace and key order and breaks every real
 *  integrator. */
export function verifyEventSignature(key: string, tsSec: number, rawBody: string, header: string): boolean {
  requireKey(key);
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  return equalBytes(provided, hmac(key, `${tsSec}.${rawBody}`));
}

/** Clock skew, enforced in BOTH directions — a future timestamp is as invalid
 *  as a stale one, or a signer with a fast clock mints requests that stay
 *  replayable after the nonce expires. */
export function withinSkew(tsSec: number, nowSec: number, skewSec: number = AI_EVENT_SKEW_SEC): boolean {
  if (!Number.isFinite(tsSec)) return false;
  return Math.abs(nowSec - tsSec) <= skewSec;
}
