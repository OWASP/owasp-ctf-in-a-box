import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ADMIN_AUDIT_KEY, AUDIT_CAP, type AuditActor } from "@/lib/admin-audit-keys";
import { ADMIN_GRANTS_KEY } from "@/lib/admin-grants";
import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";
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
/** HASH player id -> grant generation. REVOKE_SCRIPT advances the target's
 *  generation, ISSUE_SCRIPT stamps the issuer's current one into the code, and
 *  CLAIM_SCRIPT honours a code only while the two still match, so a code
 *  issued before a revoke stays dead after a re-grant. Under `ctf:admin:`
 *  like the grants, so a master reset keeps it and the event archive does
 *  not carry it: a reset that zeroed it would revive pre-reset codes. */
export const ADMIN_GRANT_GEN_KEY = "ctf:admin:grant-gen";

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

/** Set while a password reset writes `player`'s password (password-reset.ts
 *  RESET_GUARD_SCRIPT): CLAIM_SCRIPT refuses that player while it exists, so
 *  no grant lands between the reset's organizer check and its write. Under
 *  password-reset's `ctf:admin:reset-code:` prefix, so delete-all-accounts
 *  sweeps it with the codes; "busy:" is never a code hash. */
export const resetBusyKey = (player: string): string => `ctf:admin:reset-code:busy:${player}`;

/**
 * KEYS [grants, spent, codeKey, audit, grantGen, userRows, resetBusy]
 * ARGV [playerId, playerName, hash, bootstrapHash, at, cap-1]
 *
 * An existing admin consumes nothing, and neither does an id with no account
 * row (`invalid`): a session that outlives its account in the cookie cache,
 * after a delete or delete-all, must not take the grant or spend the code the
 * organizer rotated for the real claim. The bootstrap path matches only the
 * CURRENT env hash and only once (the spent set); it works whether or not
 * admins exist, because recovery includes an admin who still holds a grant
 * but cannot sign in. The issued path is GET then DEL in the same script, so
 * two racing claims grant exactly once, and it honours a code only while its
 * issuer still holds a grant AND the grant generation stamped into the code
 * is still the issuer's current one: revoking an admin advances that
 * generation, so every code they issued stays void even after they are
 * granted again, or a removed admin's code could be claimed back. An entry
 * with no readable issuer or generation is refused the same way (fail closed).
 * A claim while a password reset is writing this player's password is `busy`,
 * with nothing consumed: the caller answers 503 and the player tries again.
 */
export const CLAIM_SCRIPT = `
local grants, spent, codeKey, audit, gens, users = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local id, name, hash, boot, at, cap = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], tonumber(ARGV[6])
if redis.call('SISMEMBER', grants, id) == 1 then return {'already-admin'} end
if redis.call('HEXISTS', users, id) == 0 then return {'invalid'} end
if redis.call('EXISTS', KEYS[7]) == 1 then return {'busy'} end
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
  local gen = ok and type(issued) == 'table' and type(issued.gen) == 'number' and issued.gen
  if issuer == '' or not gen or redis.call('SISMEMBER', grants, issuer) == 0 then return {'invalid'} end
  if gen ~= tonumber(redis.call('HGET', gens, issuer) or '0') then return {'invalid'} end
  entry.via = 'code'
  entry.issuedBy = issuer
end
redis.call('SADD', grants, id)
redis.call('LPUSH', audit, cjson.encode(entry))
redis.call('LTRIM', audit, 0, cap)
return {'ok', entry.via}`;

/** KEYS [grants, codeKey, audit, grantGen]; ARGV [actorId, valueJson, ttl,
 *  auditLine, cap-1]. 1 when stored, 0 on an NX collision, -1 when the actor
 *  no longer holds a grant (a revoke that lands before the issue mints
 *  nothing). Neither refusal writes an audit line. The stored value is
 *  `valueJson` plus `gen`, the actor's grant generation read here, in the
 *  same step as the grant check, so no revoke can fall between them. */
export const ISSUE_SCRIPT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return -1 end
local value = cjson.decode(ARGV[2])
value.gen = tonumber(redis.call('HGET', KEYS[4], ARGV[1]) or '0')
local ok = redis.call('SET', KEYS[2], cjson.encode(value), 'EX', tonumber(ARGV[3]), 'NX')
if not ok then return 0 end
redis.call('LPUSH', KEYS[3], ARGV[4])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[5]))
return 1`;

/** The acting admin lost their grant before the script ran (an issue or a
 *  revoke). Routes answer it with 403, the same as their own gate. */
export class NotAdminError extends Error {
  constructor() {
    super("admin: the acting admin holds no grant");
    this.name = "NotAdminError";
  }
}

/** KEYS [grants, audit, grantGen, userRows]; ARGV [targetId, actorId,
 *  auditLine, cap-1]. The actor must still hold a grant when the script runs,
 *  so an admin revoked after the route's gate cannot remove anyone. Refuses
 *  unless another grant belongs to an account that still exists (a field in
 *  the auth store's user rows hash): a grant whose account is deleted opens
 *  nothing, and with no usable grant left nobody can open /admin to issue a
 *  code. Counting here, not in the route, keeps the check atomic with the
 *  removal. Advances the target's grant generation, voiding the codes they
 *  issued (see CLAIM_SCRIPT). */
export const REVOKE_SCRIPT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 0 then return {'not-admin-actor'} end
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return {'not-admin'} end
local live = 0
for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  if m ~= ARGV[1] and redis.call('HEXISTS', KEYS[4], m) == 1 then live = live + 1 end
end
if live == 0 then return {'last-admin'} end
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[1], 1)
redis.call('LPUSH', KEYS[2], ARGV[3])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4]))
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
    [
      ADMIN_GRANTS_KEY,
      ADMIN_CLAIM_SPENT_KEY,
      `${ADMIN_CODE_PREFIX}${hash}`,
      ADMIN_AUDIT_KEY,
      ADMIN_GRANT_GEN_KEY,
      rowsKey(AUTH_PREFIX, "user"),
      resetBusyKey(player.id),
    ],
    [player.id, player.name, hash, boot, new Date().toISOString(), String(AUDIT_CAP - 1)],
  );
  const [head, via] = Array.isArray(res) ? (res as unknown[]) : [];
  if (head === "ok" && (via === "bootstrap" || via === "code")) return { ok: true, via };
  if (head === "invalid" || head === "already-admin") return { ok: false, reason: head };
  // Transient, and nothing was consumed: the caller's 503 asks for a retry.
  if (head === "busy") throw new Error("admin claim: a password reset for this player is being written");
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
      [ADMIN_GRANTS_KEY, `${ADMIN_CODE_PREFIX}${hash}`, ADMIN_AUDIT_KEY, ADMIN_GRANT_GEN_KEY],
      [actor.id, value, String(ADMIN_CODE_TTL_SECONDS), line, String(AUDIT_CAP - 1)],
    );
    if (Number(res) === 1) return { code: formatClaimCode(normalized), expiresAt };
    if (Number(res) === -1) throw new NotAdminError();
  }
  throw new Error("admin code: two collisions in a row");
}

export type RevokeResult = { ok: true; grants: string[] } | { ok: false; reason: "not-admin" | "last-admin" };

/** Remove `target`'s grant. Self-removal is allowed; removing the last grant
 *  whose account still exists is not.
 *  Throws `NotAdminError` when `actor` no longer holds a grant. */
export async function revokeAdmin(target: { id: string; name: string }, actor: AuditActor): Promise<RevokeResult> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    by: actor.id,
    name: actor.name,
    action: "admin:revoke",
    player: target.id,
    playerName: target.name,
  });
  const res = await upstashEval(
    REVOKE_SCRIPT,
    [ADMIN_GRANTS_KEY, ADMIN_AUDIT_KEY, ADMIN_GRANT_GEN_KEY, rowsKey(AUTH_PREFIX, "user")],
    [target.id, actor.id, line, String(AUDIT_CAP - 1)],
  );
  const arr = Array.isArray(res) ? (res as unknown[]) : [];
  if (arr[0] === "ok") return { ok: true, grants: arr.slice(1).map(String).sort() };
  if (arr[0] === "not-admin-actor") throw new NotAdminError();
  if (arr[0] === "not-admin" || arr[0] === "last-admin") return { ok: false, reason: arr[0] };
  throw new Error("admin revoke: unexpected script reply");
}
