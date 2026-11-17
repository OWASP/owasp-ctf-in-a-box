import "server-only";
import { upstashEval } from "@/lib/upstash";
import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";

/**
 * `ctf:deleted:<player id>` marks a player whose delete has started. It is a
 * SET of tokens, one fresh token per delete call still in flight or finished.
 * The scorer reads its EXISTS atomically with its solve write
 * (scorer/src/store.js, RECORD_SOLVES_SCRIPT): marker plus account row is
 * "pending" (503, sync retries), marker with the row gone is "deleted" (422,
 * final), no marker writes. A delete that fails lifts only its own token, so a
 * concurrent delete of the same player keeps the marker it needs; a finished
 * delete's token stays for good.
 *
 * The key has no expiry and is not in RESET_PREFIXES: a master reset keeps
 * it, so a deleted player's PR stays refused across events. The scorer pins
 * the same prefix and rows key on its side; a change here changes both.
 */
export const DELETED_PREFIX = "ctf:deleted:";

export const deletedKey = (player: string): string => `${DELETED_PREFIX}${player}`;

/** The better-auth user rows hash the scorer checks for the account row. */
export const AUTH_USER_ROWS_KEY = rowsKey(AUTH_PREFIX, "user");

// KEYS: [1]=ctf:deleted:<player>  ARGV: [1]=token. Adds this call's token,
// whatever the set already holds.
export const MARK_DELETING_SCRIPT = `redis.call('SADD', KEYS[1], ARGV[1])
return 1`;

// KEYS: [1]=ctf:deleted:<player> [2]=ctf:auth:user  ARGV: [1]=player [2]=token.
// Lifts this call's token only while the account row still exists: with the
// row gone the player is deleted (by this call or a concurrent one) and the
// marker stays. Redis drops the key when the set empties; tokens left behind
// belong to other deletes of this player: running, or failed without lifting
// theirs ('in-flight').
export const RESTORE_AFTER_FAILED_DELETE_SCRIPT = `if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  redis.call('SREM', KEYS[1], ARGV[2])
  if redis.call('EXISTS', KEYS[1]) == 1 then return 'in-flight' end
  return 'restored'
end
return 'kept'`;

export type RestoreOutcome = "restored" | "in-flight" | "kept";

/** Adds this delete's token to `player`'s marker and returns it. Throws if
 *  the add is not confirmed, so the delete stops before any write. */
export async function markDeleting(player: string): Promise<string> {
  const token = crypto.randomUUID();
  const reply = await upstashEval(MARK_DELETING_SCRIPT, [deletedKey(player)], [token]);
  if (reply !== 1) throw new Error("delete user: the deleted marker was not set");
  return token;
}

/** Lifts this delete's token when the account row survived the failure.
 *  Throws on anything but the script's three answers. */
export async function restoreAfterFailedDelete(player: string, token: string): Promise<RestoreOutcome> {
  const reply = await upstashEval(
    RESTORE_AFTER_FAILED_DELETE_SCRIPT,
    [deletedKey(player), AUTH_USER_ROWS_KEY],
    [player, token],
  );
  if (reply !== "restored" && reply !== "in-flight" && reply !== "kept") {
    throw new Error("delete user: unexpected reply restoring the deleted marker");
  }
  return reply;
}
