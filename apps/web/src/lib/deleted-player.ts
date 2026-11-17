import "server-only";
import { upstashEval } from "@/lib/upstash";
import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";

/**
 * `ctf:deleted:<player id>` marks a player whose delete has started. The
 * scorer reads it atomically with its solve write (scorer/src/store.js,
 * RECORD_SOLVES_SCRIPT): marker plus account row is "pending" (503, sync
 * retries), marker with the row gone is "deleted" (422, final), no marker
 * writes. The value is `pending:<token>`, one fresh token per delete call, so
 * a failed delete removes only its own marker.
 *
 * The key has no expiry and is not in RESET_PREFIXES: a master reset keeps
 * it, so a deleted player's PR stays refused across events. The scorer pins
 * the same prefix and rows key on its side; a change here changes both.
 */
export const DELETED_PREFIX = "ctf:deleted:";

export const deletedKey = (player: string): string => `${DELETED_PREFIX}${player}`;

/** The better-auth user rows hash the scorer checks for the account row. */
export const AUTH_USER_ROWS_KEY = rowsKey(AUTH_PREFIX, "user");

// KEYS: [1]=ctf:deleted:<player>  ARGV: [1]=token. Unconditional: a re-run
// after a finished or failed delete re-marks with its own token.
export const MARK_DELETING_SCRIPT = `redis.call('SET', KEYS[1], 'pending:' .. ARGV[1])
return 1`;

// KEYS: [1]=ctf:deleted:<player> [2]=ctf:auth:user  ARGV: [1]=player [2]=token.
// Removes the marker only while the account row still exists AND the marker
// is this call's own. With the row gone the player is deleted (by this call
// or a concurrent one), and a marker with another token belongs to a delete
// still running: both stay.
export const RESTORE_AFTER_FAILED_DELETE_SCRIPT = `if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1
  and redis.call('GET', KEYS[1]) == 'pending:' .. ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 'restored'
end
return 'kept'`;

/** Marks `player` deleted and returns this delete's token. Throws if the mark
 *  is not confirmed, so the delete stops before any write. */
export async function markDeleting(player: string): Promise<string> {
  const token = crypto.randomUUID();
  const reply = await upstashEval(MARK_DELETING_SCRIPT, [deletedKey(player)], [token]);
  if (reply !== 1) throw new Error("delete user: the deleted marker was not set");
  return token;
}

/** Removes this delete's marker when the account row survived the failure.
 *  Throws on anything but the script's two answers. */
export async function restoreAfterFailedDelete(player: string, token: string): Promise<"restored" | "kept"> {
  const reply = await upstashEval(
    RESTORE_AFTER_FAILED_DELETE_SCRIPT,
    [deletedKey(player), AUTH_USER_ROWS_KEY],
    [player, token],
  );
  if (reply !== "restored" && reply !== "kept") {
    throw new Error("delete user: unexpected reply restoring the deleted marker");
  }
  return reply;
}
