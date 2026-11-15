import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ADMIN_AUDIT_KEY, AUDIT_CAP, type AuditActor } from "@/lib/admin-audit-keys";
import { ADMIN_GRANTS_KEY } from "@/lib/admin-grants";
import { upstashEval } from "@/lib/upstash";

/**
 * Admin claim codes: the only way a kit account becomes an admin (ADR 72).
 *
 * A code is 128 random bits shown as 32 lowercase hex in eight groups of four.
 * Only its SHA-256 is ever stored or compared: the bootstrap hash comes from
 * the process environment (`ADMIN_CLAIM_CODE_HASH`, written by setup), and an
 * admin-issued code lives as `ctf:admin:code:<hash>` for 15 minutes. The code
 * has 128 bits of entropy, so a plain unsalted hash is enough; a slow KDF
 * protects low-entropy secrets and buys nothing here.
 *
 * Never log, audit or return a code or a full hash outside the one place a
 * fresh code is shown to the admin who issued it. Audit rows carry `codeId`,
 * the first eight hex of the hash.
 */

export const ADMIN_CODE_PREFIX = "ctf:admin:code:";
/** Bootstrap hashes already used. Single use is per hash VALUE, so rotating
 *  the env hash is what makes a new bootstrap code. */
export const ADMIN_CLAIM_SPENT_KEY = "ctf:admin:claim:spent";
export const ADMIN_CODE_TTL_SECONDS = 900;

const CODE_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** Lowercase, drop hyphens and whitespace; `null` unless exactly 32 hex
 *  remain. Must stay identical to the shell helper's normalization. */
export function normalizeClaimCode(input: string): string | null {
  if (typeof input !== "string") return null;
  const n = input.toLowerCase().replace(/[-\s]/g, "");
  return CODE_RE.test(n) ? n : null;
}

/** Lowercase hex SHA-256 of a normalized code. */
export function hashClaimCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/** `0123456789abcdef…` → `0123-4567-89ab-cdef-…`. */
export function formatClaimCode(hex32: string): string {
  return (hex32.match(/.{1,4}/g) ?? []).join("-");
}

/** The name an audit row gives a code: enough to match two rows, too short to
 *  stand in for the hash. */
export function codeId(hash: string): string {
  return hash.slice(0, 8);
}

/**
 * KEYS [grants, spent, codeKey, audit]
 * ARGV [playerId, playerName, hash, bootstrapHash, at, cap-1]
 *
 * An existing admin consumes nothing. The bootstrap path matches only the
 * CURRENT env hash and only once (the spent set); it works whether or not
 * admins exist, because recovery includes an admin who still holds a grant
 * but cannot sign in. The issued path is GET then DEL in the same script, so
 * two racing claims grant exactly once, and it honours a code only while its
 * issuer still holds a grant: revoking an admin voids every code they issued,
 * or a removed admin could claim one back. An entry with no readable issuer
 * is refused the same way (fail closed).
 */
export const CLAIM_SCRIPT = `
local grants, spent, codeKey, audit = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local id, name, hash, boot, at, cap = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], tonumber(ARGV[6])
if redis.call('SISMEMBER', grants, id) == 1 then return {'already-admin'} end
local entry = {at = at, by = id, name = name, action = 'admin:grant', player = id, playerName = name, codeId = string.sub(hash, 1, 8)}
if hash ~= '' and boot ~= '' and hash == boot and redis.call('SISMEMBER', spent, hash) == 0 then
  redis.call('SADD', spent, hash)
  entry.via = 'bootstrap'
else
  local raw = redis.call('GET', codeKey)
  if not raw then return {'invalid'} end
  redis.call('DEL', codeKey)
  local ok, issued = pcall(cjson.decode, raw)
  local issuer = (ok and type(issued) == 'table' and type(issued.by) == 'string' and issued.by) or ''
  if issuer == '' or redis.call('SISMEMBER', grants, issuer) == 0 then return {'invalid'} end
  entry.via = 'code'
  entry.issuedBy = issuer
end
redis.call('SADD', grants, id)
redis.call('LPUSH', audit, cjson.encode(entry))
redis.call('LTRIM', audit, 0, cap)
return {'ok', entry.via}`;

/** KEYS [grants, codeKey, audit]; ARGV [actorId, valueJson, ttl, auditLine, cap-1].
 *  1 when stored, 0 on an NX collision, -1 when the actor no longer holds a
 *  grant (a revoke that lands before the issue mints nothing). Neither
 *  refusal writes an audit line. */
export const ISSUE_SCRIPT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return -1 end
local ok = redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]), 'NX')
if not ok then return 0 end
redis.call('LPUSH', KEYS[3], ARGV[4])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[5]))
return 1`;

/** The issuer lost their grant before the code was stored. */
export class NotAdminError extends Error {
  constructor() {
    super("admin code: the issuer holds no grant");
    this.name = "NotAdminError";
  }
}

/** KEYS [grants, audit]; ARGV [targetId, auditLine, cap-1]. Refuses the last
 *  grant: with none left, nobody can open /admin to issue a code. */
export const REVOKE_SCRIPT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return {'not-admin'} end
if redis.call('SCARD', KEYS[1]) <= 1 then return {'last-admin'} end
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('LPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[3]))
local members = redis.call('SMEMBERS', KEYS[1])
table.insert(members, 1, 'ok')
return members`;

export type ClaimResult = { ok: true; via: "bootstrap" | "code" } | { ok: false; reason: "invalid" | "already-admin" };

/** Claim admin for `player` with `code`. `bootstrapHash` is the env hash; any
 *  value that is not a SHA-256 disables the bootstrap path. Throws on a Redis
 *  failure: the caller answers 503, never a grant. */
export async function claimAdmin(code: string, player: AuditActor, bootstrapHash: string): Promise<ClaimResult> {
  const normalized = normalizeClaimCode(code);
  if (normalized === null) return { ok: false, reason: "invalid" };
  const hash = hashClaimCode(normalized);
  const boot = HASH_RE.test(bootstrapHash) ? bootstrapHash : "";
  const res = await upstashEval(
    CLAIM_SCRIPT,
    [ADMIN_GRANTS_KEY, ADMIN_CLAIM_SPENT_KEY, `${ADMIN_CODE_PREFIX}${hash}`, ADMIN_AUDIT_KEY],
    [player.id, player.name, hash, boot, new Date().toISOString(), String(AUDIT_CAP - 1)],
  );
  const [head, via] = Array.isArray(res) ? (res as unknown[]) : [];
  if (head === "ok" && (via === "bootstrap" || via === "code")) return { ok: true, via };
  if (head === "invalid" || head === "already-admin") return { ok: false, reason: head };
  throw new Error("admin claim: unexpected script reply");
}

/** Issue a single-use code that expires in 15 minutes. Returns the code for
 *  the one display to the issuing admin; only its hash is stored. Throws
 *  `NotAdminError` when the actor's grant is gone by the time the script runs. */
export async function issueAdminCode(actor: AuditActor): Promise<{ code: string; expiresAt: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const normalized = randomBytes(16).toString("hex");
    const hash = hashClaimCode(normalized);
    const now = Date.now();
    const at = new Date(now).toISOString();
    const expiresAt = new Date(now + ADMIN_CODE_TTL_SECONDS * 1000).toISOString();
    const value = JSON.stringify({ by: actor.id, name: actor.name });
    const line = JSON.stringify({ at, by: actor.id, name: actor.name, action: "admin:code-issue", codeId: codeId(hash), expiresAt });
    const res = await upstashEval(
      ISSUE_SCRIPT,
      [ADMIN_GRANTS_KEY, `${ADMIN_CODE_PREFIX}${hash}`, ADMIN_AUDIT_KEY],
      [actor.id, value, String(ADMIN_CODE_TTL_SECONDS), line, String(AUDIT_CAP - 1)],
    );
    if (Number(res) === 1) return { code: formatClaimCode(normalized), expiresAt };
    if (Number(res) === -1) throw new NotAdminError();
  }
  throw new Error("admin code: two collisions in a row");
}

export type RevokeResult = { ok: true; grants: string[] } | { ok: false; reason: "not-admin" | "last-admin" };

/** Remove `target`'s grant. Self-removal is allowed; the last grant is not. */
export async function revokeAdmin(target: { id: string; name: string }, actor: AuditActor): Promise<RevokeResult> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    by: actor.id,
    name: actor.name,
    action: "admin:revoke",
    player: target.id,
    playerName: target.name,
  });
  const res = await upstashEval(REVOKE_SCRIPT, [ADMIN_GRANTS_KEY, ADMIN_AUDIT_KEY], [target.id, line, String(AUDIT_CAP - 1)]);
  const arr = Array.isArray(res) ? (res as unknown[]) : [];
  if (arr[0] === "ok") return { ok: true, grants: arr.slice(1).map(String).sort() };
  if (arr[0] === "not-admin" || arr[0] === "last-admin") return { ok: false, reason: arr[0] };
  throw new Error("admin revoke: unexpected script reply");
}
