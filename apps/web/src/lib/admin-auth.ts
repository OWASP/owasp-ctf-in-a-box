import "server-only";
import { isAdminGrantee } from "@/lib/admin-grants";
import { getPlayer, PLAYER_ID_RE, type Player } from "@/lib/player";

/**
 * True when `playerId` holds an admin grant (ADR 72). Admin-ness is decided
 * by the kit player id alone; a GitHub login, linked or not, grants nothing.
 *
 * False for anything that is not a player id, without a Redis read. A Redis
 * error THROWS, so each caller applies its own fail direction instead of
 * reading an outage as "not an admin" by accident.
 */
export async function isAdminPlayer(playerId: string | undefined): Promise<boolean> {
  if (typeof playerId !== "string" || !PLAYER_ID_RE.test(playerId)) return false;
  return isAdminGrantee(playerId);
}

/**
 * The signed-in admin, or why not. FAIL CLOSED: a grant read that throws is a
 * 403. This is deliberately the opposite of `effectivePaused`'s read, which
 * fails OPEN so a Redis blip cannot drop live submissions: that one is a
 * safety switch, and this one is an access check whose failure must not grant
 * access.
 */
export async function requireAdmin(
  headers: Headers,
): Promise<{ ok: true; player: Player } | { ok: false; status: 401 | 403 }> {
  const player = await getPlayer(headers);
  if (!player) return { ok: false, status: 401 };
  try {
    if (await isAdminGrantee(player.id)) return { ok: true, player };
  } catch {
    return { ok: false, status: 403 };
  }
  return { ok: false, status: 403 };
}
