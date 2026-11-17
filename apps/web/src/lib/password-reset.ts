import "server-only";
import { randomBytes } from "node:crypto";
import { ADMIN_AUDIT_KEY, AUDIT_CAP, type AuditActor } from "@/lib/admin-audit-keys";
import { ADMIN_GRANT_GEN_KEY, codeId, formatClaimCode, hashClaimCode, normalizeClaimCode, NotAdminError } from "@/lib/admin-claim";
import { ADMIN_GRANTS_KEY } from "@/lib/admin-grants";
import { auth } from "@/lib/auth";
import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";
import { errorLabel } from "@/lib/error-label";
import { OpsValidationError } from "@/lib/ops-errors";
import { PLAYER_ID_RE } from "@/lib/player";
import { assertPipelineOk, upstashEval, upstashPipeline } from "@/lib/upstash";

/**
 * Password reset codes an organizer hands a player.
 *
 * An admin issues a code for one player from /admin and passes it on; the
 * player redeems it, signed out, at /reset with a password of their choosing.
 * The admin never sees or sets the password. Codes are claim codes in every
 * other respect (admin-claim.ts): 128 random bits shown once as eight groups
 * of four hex, stored only as their SHA-256, single use, 15 minutes, and
 * audited by `codeId` alone. Never log, audit or return a code outside the one
 * display to the issuing admin.
 *
 * Keys, all under `ctf:admin:` so a master reset keeps them like the claim
 * codes (delete-all-accounts clears the prefix):
 * - `<prefix><hash>`: JSON `{player, by, name, gen}`, EX 900. `gen` is the
 *   issuer's grant generation, stamped by the issue script; a code is honoured
 *   only while its issuer still holds a grant at that generation, the same
 *   rule CLAIM_SCRIPT applies, so a revoked admin's codes die with the grant.
 * - `<prefix>by:<playerId>`: the hash of that player's current code, EX 900.
 *   Issuing a new code deletes the one it names, so a player holds at most
 *   one live code. A hash is 64 hex and never starts `by:`, so the two never
 *   collide.
 */

export const RESET_CODE_PREFIX = "ctf:admin:reset-code:";
export const RESET_CODE_TTL_SECONDS = 900;
/** The `emailAndPassword` bounds in auth.ts. */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const HASH_RE = /^[0-9a-f]{64}$/;

export const resetCodeKey = (hash: string) => `${RESET_CODE_PREFIX}${hash}`;
export const resetPointerKey = (player: string) => `${RESET_CODE_PREFIX}by:${player}`;

/**
 * KEYS [grants, pointer, newCode, prevCode, audit, userRows, grantGen]
 * ARGV [actorId, playerId, valueJson, ttl, auditLine, cap-1, newHash, expectedPrev]
 *
 * -1: the actor holds no grant. -2: the player has no auth user row. -4: the
 * player holds an admin grant: a reset code would let whoever holds it sign in
 * as an organizer, so the grant is revoked first, as for a delete. -3: the
 * pointer no longer names `expectedPrev` (another issue for this player landed
 * between the caller's read and this script): the caller re-reads and retries.
 * 0: an NX collision on the new code. 1: stored, previous code deleted, pointer
 * moved, audited. No refusal writes anything. `prevCode` is the pointer key
 * itself when there is no previous code, and is then left alone: the keys a
 * script touches are all named in KEYS, so the caller resolves the previous
 * code's key and the pointer check here proves it is still the current one.
 */
export const ISSUE_RESET_SCRIPT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return -1 end
if redis.call('HEXISTS', KEYS[6], ARGV[2]) == 0 then return -2 end
if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1 then return -4 end
local prev = redis.call('GET', KEYS[2]) or ''
if prev ~= ARGV[8] then return -3 end
local value = cjson.decode(ARGV[3])
value.gen = tonumber(redis.call('HGET', KEYS[7], ARGV[1]) or '0')
local ttl = tonumber(ARGV[4])
if not redis.call('SET', KEYS[3], cjson.encode(value), 'EX', ttl, 'NX') then return 0 end
if KEYS[4] ~= KEYS[2] then redis.call('DEL', KEYS[4]) end
redis.call('SET', KEYS[2], ARGV[7], 'EX', ttl)
redis.call('LPUSH', KEYS[5], ARGV[5])
redis.call('LTRIM', KEYS[5], 0, tonumber(ARGV[6]))
return 1`;

/**
 * KEYS [code, pointer, grants, grantGen]; ARGV [hash, playerId].
 *
 * GET then DEL in one script, so two racing redeems consume a code exactly
 * once, and the code is spent before any password is written. The pointer is
 * deleted only while it still names this hash (a newer code keeps its own).
 * An entry that names another player, or a player who has since been granted
 * admin (the issue script refuses an organizer, and a grant after the issue
 * must not reopen that), has no readable issuer or generation, or whose issuer
 * has since lost the grant or moved generation is `invalid` and still
 * consumed (fail closed).
 */
export const CONSUME_RESET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'invalid'} end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
local ok, v = pcall(cjson.decode, raw)
if not ok or type(v) ~= 'table' or v.player ~= ARGV[2] then return {'invalid'} end
if redis.call('SISMEMBER', KEYS[3], v.player) == 1 then return {'invalid'} end
local issuer = (type(v.by) == 'string' and v.by) or ''
local gen = type(v.gen) == 'number' and v.gen
if issuer == '' or not gen or redis.call('SISMEMBER', KEYS[3], issuer) == 0 then return {'invalid'} end
if gen ~= tonumber(redis.call('HGET', KEYS[4], issuer) or '0') then return {'invalid'} end
return {'ok', v.player}`;

/** Issue a single-use reset code for `playerId`, valid for 15 minutes, voiding
 *  the player's previous one. Returns the code for the one display to the
 *  issuing admin; only its hash is stored. Throws `NotAdminError` when the
 *  actor's grant is gone by the time the script runs, `OpsValidationError`
 *  on `id` for a malformed id, a player with no account or a player who holds
 *  an admin grant, and any store error as is (the caller answers 503). */
export async function issuePasswordResetCode(playerId: string, actor: AuditActor): Promise<{ code: string; expiresAt: string }> {
  if (typeof playerId !== "string" || !PLAYER_ID_RE.test(playerId)) {
    throw new OpsValidationError("id", "invalid player id");
  }
  const pointer = resetPointerKey(playerId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [prevRes] = assertPipelineOk(await upstashPipeline([["GET", pointer]]), "reset code pointer");
    const prev = typeof prevRes.result === "string" ? prevRes.result : "";
    const prevKey = HASH_RE.test(prev) ? resetCodeKey(prev) : pointer;

    const normalized = randomBytes(16).toString("hex");
    const hash = hashClaimCode(normalized);
    const now = Date.now();
    const at = new Date(now).toISOString();
    const expiresAt = new Date(now + RESET_CODE_TTL_SECONDS * 1000).toISOString();
    const value = JSON.stringify({ player: playerId, by: actor.id, name: actor.name });
    const line = JSON.stringify({
      at,
      by: actor.id,
      name: actor.name,
      action: "ops:password-reset-code",
      player: playerId,
      codeId: codeId(hash),
    });
    const res = Number(
      await upstashEval(
        ISSUE_RESET_SCRIPT,
        [ADMIN_GRANTS_KEY, pointer, resetCodeKey(hash), prevKey, ADMIN_AUDIT_KEY, rowsKey(AUTH_PREFIX, "user"), ADMIN_GRANT_GEN_KEY],
        [actor.id, playerId, value, String(RESET_CODE_TTL_SECONDS), line, String(AUDIT_CAP - 1), hash, prev],
      ),
    );
    if (res === 1) return { code: formatClaimCode(normalized), expiresAt };
    if (res === -1) throw new NotAdminError();
    if (res === -2) throw new OpsValidationError("id", "No player with that id");
    if (res === -4) throw new OpsValidationError("id", `${await displayName(playerId)} is an organizer. Revoke their admin access first.`);
  }
  throw new Error("password reset: could not store a code after three attempts");
}

/** The name the refusal copy shows, as the admin's player lookup shows it. */
async function displayName(playerId: string): Promise<string> {
  const { internalAdapter } = await auth.$context;
  const user = (await internalAdapter.findUserById(playerId)) as { name?: string; displayUsername?: string | null } | null;
  return user?.displayUsername || user?.name || "This player";
}

export type RedeemResult = { ok: true; player: string } | { ok: false; reason: "invalid" | "password" };

/**
 * Redeem `rawCode`, setting the player's password to `newPassword` and
 * signing them out everywhere.
 *
 * The password bounds are checked first, so a bad password spends no code.
 * The code is then consumed in Lua BEFORE the password is written: two racing
 * redeems cannot both write. A store or auth failure after the consume throws
 * (the caller answers 503); the code is gone by then, and the organizer
 * issues a new one. Success is never reported for a write that did not land.
 */
export async function redeemPasswordResetCode(rawCode: string, newPassword: string): Promise<RedeemResult> {
  if (typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
    return { ok: false, reason: "password" };
  }
  const normalized = normalizeClaimCode(rawCode);
  if (normalized === null) return { ok: false, reason: "invalid" };
  const hash = hashClaimCode(normalized);
  const key = resetCodeKey(hash);

  // The pointer key is per player, so the consume script needs the player
  // before it runs. The script re-reads the entry and checks the same player.
  const [read] = assertPipelineOk(await upstashPipeline([["GET", key]]), "reset code read");
  if (typeof read.result !== "string") return { ok: false, reason: "invalid" };
  let player: unknown;
  try {
    player = (JSON.parse(read.result) as { player?: unknown } | null)?.player;
  } catch {
    player = undefined;
  }
  if (typeof player !== "string" || !PLAYER_ID_RE.test(player)) return { ok: false, reason: "invalid" };

  const consumed = await upstashEval(CONSUME_RESET_SCRIPT, [key, resetPointerKey(player), ADMIN_GRANTS_KEY, ADMIN_GRANT_GEN_KEY], [hash, player]);
  const [head] = Array.isArray(consumed) ? (consumed as unknown[]) : [];
  if (head === "invalid") return { ok: false, reason: "invalid" };
  if (head !== "ok") throw new Error("password reset: unexpected script reply");

  const { internalAdapter, password } = await auth.$context;
  const user = (await internalAdapter.findUserById(player)) as { name?: string; displayUsername?: string | null } | null;
  if (!user) return { ok: false, reason: "invalid" };

  const passwordHash = await password.hash(newPassword);
  // Any credential row, whatever its accountId: better-auth's updatePassword
  // matches only accountId = userId and would silently update nothing else.
  const credentials = (await internalAdapter.findAccounts(player)).filter((a) => a.providerId === "credential");
  if (credentials.length === 0) {
    await internalAdapter.linkAccount({ userId: player, providerId: "credential", accountId: player, password: passwordHash });
  } else {
    for (const account of credentials) await internalAdapter.updateAccount(account.id, { password: passwordHash });
  }
  await internalAdapter.deleteUserSessions(player);

  await auditUse(player, user.displayUsername || user.name || "", hash);
  return { ok: true, player };
}

/** Best-effort, like admin-ops-store's audit: the password is already set, so
 *  a failed line is logged and the redeem still reports what it did. */
async function auditUse(player: string, name: string, hash: string): Promise<void> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    by: player,
    name,
    action: "ops:password-reset-used",
    player,
    codeId: codeId(hash),
  });
  try {
    assertPipelineOk(
      await upstashPipeline([
        ["LPUSH", ADMIN_AUDIT_KEY, line],
        ["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1],
      ]),
      "audit ops:password-reset-used",
    );
  } catch (err) {
    console.error("[password-reset] audit write failed", errorLabel(err));
  }
}
