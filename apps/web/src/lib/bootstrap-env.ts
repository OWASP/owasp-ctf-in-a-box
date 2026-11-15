import "server-only";

/**
 * The bootstrap values config v2 reads straight from the process environment:
 * the GitHub org contestants fork under, and the hash of the one-time admin
 * claim code. `server-only` because `process.env` on the client bundle would
 * be empty or misleading, and because the hash must never reach a browser.
 *
 * Each takes an `env` param (default `process.env`) so tests can pass a
 * fixture. Typed as `Record<string, string | undefined>`, not Next's
 * `ProcessEnv`, which requires `NODE_ENV`.
 */

/** The GitHub org contestants fork the target repos under. Trimmed; `""`
 *  when unset — callers decide what an empty org means for them (there is
 *  no baked default to fall back to). */
export function getGithubOrg(env: Record<string, string | undefined> = process.env): string {
  return (env.GITHUB_ORG ?? "").trim();
}

const HASH_RE = /^[0-9a-f]{64}$/;
let warnedBadHash = false;

/**
 * `ADMIN_CLAIM_CODE_HASH`, the SHA-256 of the bootstrap admin claim code
 * (ADR 73), trimmed and lowercased. Anything that is not 64 hex — most likely
 * the code itself pasted where its hash belongs — counts as unset, so nobody
 * can claim with it. That case logs one warning per process naming the key,
 * never the value: a pasted code IS the secret.
 */
export function adminClaimCodeHash(env: Record<string, string | undefined> = process.env): string {
  const value = (env.ADMIN_CLAIM_CODE_HASH ?? "").trim().toLowerCase();
  if (value === "") return "";
  if (HASH_RE.test(value)) return value;
  if (!warnedBadHash) {
    warnedBadHash = true;
    console.warn("[bootstrap-env] ADMIN_CLAIM_CODE_HASH is not a 64-hex SHA-256; treating it as unset");
  }
  return "";
}
