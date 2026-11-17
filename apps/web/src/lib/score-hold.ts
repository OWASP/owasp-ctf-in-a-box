import "server-only";
import { upstashEval } from "@/lib/upstash";
import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";

/**
 * `ctf:score-hold:<player id>` holds a player's Secure Development scores. It
 * is a SET of tokens, one fresh token per operation that holds them:
 * `deleteUser` adds one before it deletes anything, `unlinkGithub` one before
 * it takes the link. The scorer reads its EXISTS atomically with its solve
 * write (scorer/src/store.js, RECORD_SOLVES_SCRIPT): hold plus account row is
 * "pending" (503, sync retries and re-resolves the link), hold with the row
 * gone is "deleted" (422, final), no hold writes. Each operation lifts only its
 * own token, so a concurrent operation on the same player keeps the hold it
 * needs; a finished delete's token stays for good.
 *
 * The key has no expiry and is not in RESET_PREFIXES: a master reset keeps
 * it, so a deleted player id stays refused (a login can link a new account
 * after a master reset and score as that new id). The scorer pins the same
 * prefix and rows key on its side; a change here changes both.
 */
export const SCORE_HOLD_PREFIX = "ctf:score-hold:";

export const scoreHoldKey = (player: string): string => `${SCORE_HOLD_PREFIX}${player}`;

/** The better-auth user rows hash the scorer checks for the account row. */
export const AUTH_USER_ROWS_KEY = rowsKey(AUTH_PREFIX, "user");

// KEYS: [1]=ctf:score-hold:<player>  ARGV: [1]=token. Adds this call's token,
// whatever the set already holds.
export const HOLD_SCORES_SCRIPT = `redis.call('SADD', KEYS[1], ARGV[1])
return 1`;

// KEYS: [1]=ctf:score-hold:<player> [2]=ctf:auth:user  ARGV: [1]=player [2]=token.
// A failed delete's lift: removes this call's token only while the account row
// still exists. With the row gone the player is deleted (by this call or a
// concurrent one) and the hold stays. Redis drops the key when the set
// empties; tokens left behind belong to other holders of this player: running,
// or failed without lifting theirs ('in-flight').
export const RESTORE_AFTER_FAILED_DELETE_SCRIPT = `if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  redis.call('SREM', KEYS[1], ARGV[2])
  if redis.call('EXISTS', KEYS[1]) == 1 then return 'in-flight' end
  return 'restored'
end
return 'kept'`;

// KEYS: [1]=ctf:score-hold:<player>  ARGV: [1]=token. An unlink's lift:
// removes this call's token whatever the account row says, since an unlink
// never deletes the row; a delete that finished meanwhile keeps its own token.
export const RELEASE_SCORE_HOLD_SCRIPT = `redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then return 'in-flight' end
return 'released'`;

export type RestoreOutcome = "restored" | "in-flight" | "kept";
export type ReleaseOutcome = "released" | "in-flight";

/** Adds the caller's `token` to `player`'s score hold. Throws if the add is
 *  not confirmed, so the caller stops before any write. The caller owns the
 *  token so a hold whose outcome is unknown can still be lifted with it. */
export async function holdScores(player: string, token: string): Promise<void> {
  const reply = await upstashEval(HOLD_SCORES_SCRIPT, [scoreHoldKey(player)], [token]);
  if (reply !== 1) throw new Error("score hold: the hold was not set");
}

/** Lifts a failed delete's token when the account row survived the failure.
 *  Throws on anything but the script's three answers. */
export async function restoreAfterFailedDelete(player: string, token: string): Promise<RestoreOutcome> {
  const reply = await upstashEval(
    RESTORE_AFTER_FAILED_DELETE_SCRIPT,
    [scoreHoldKey(player), AUTH_USER_ROWS_KEY],
    [player, token],
  );
  if (reply !== "restored" && reply !== "in-flight" && reply !== "kept") {
    throw new Error("score hold: unexpected reply restoring after a failed delete");
  }
  return reply;
}

/** Lifts the caller's token. 'in-flight' means another holder's token remains.
 *  Throws on anything but the script's two answers. */
export async function releaseScoreHold(player: string, token: string): Promise<ReleaseOutcome> {
  const reply = await upstashEval(RELEASE_SCORE_HOLD_SCRIPT, [scoreHoldKey(player)], [token]);
  if (reply !== "released" && reply !== "in-flight") {
    throw new Error("score hold: unexpected reply releasing the hold");
  }
  return reply;
}
