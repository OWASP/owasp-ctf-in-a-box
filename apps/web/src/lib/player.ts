import "server-only";

import { auth } from "@/lib/auth";
import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";
import { displayNameOf, type NameParts } from "@/lib/display-name";
import { upstashPipeline } from "@/lib/upstash";

// Player ids are lowercase v4 UUIDs (auth.ts generateId). Lowercase means a
// `.toLowerCase()` join is the identity on them, and no id holds ":", which
// the solves hash relies on to split `<player>:<challenge>`.
export const PLAYER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Player = { id: string; name: string; image: string | null; githubLogin: string | null };

export { displayNameOf };

function toPlayer(row: NameParts & { image?: string | null }): Player {
  return {
    id: row.id,
    name: displayNameOf(row),
    image: row.image ?? null,
    githubLogin: row.login || null,
  };
}

/**
 * The signed-in player, or null when signed out or the session user id is not
 * a kit player id (a row minted before ids were UUIDs).
 */
export async function getPlayer(headers: Headers): Promise<Player | null> {
  const session = await auth.api.getSession({ headers });
  const user = session?.user as (NameParts & { image?: string | null }) | undefined;
  if (!user || typeof user.id !== "string" || !PLAYER_ID_RE.test(user.id)) return null;
  return toPlayer(user);
}

/**
 * Profiles for `ids` in one HMGET on the user rows hash. Ids with no row are
 * absent from the map. Throws on a command error: callers choose their own
 * fail direction.
 */
export async function getPlayerProfiles(
  ids: readonly string[],
  prefix: string = AUTH_PREFIX,
): Promise<Map<string, Player>> {
  const out = new Map<string, Player>();
  if (ids.length === 0) return out;
  const [reply] = await upstashPipeline([["HMGET", rowsKey(prefix, "user"), ...ids]]);
  if (!reply || reply.error) throw new Error(`player profiles: HMGET failed: ${reply?.error ?? "no reply"}`);
  if (!Array.isArray(reply.result)) throw new Error("player profiles: HMGET reply is not an array");
  reply.result.forEach((json, i) => {
    if (json === null) return;
    if (typeof json !== "string") throw new Error("player profiles: stored row is not a string");
    const row = JSON.parse(json) as NameParts & { image?: string | null };
    out.set(ids[i], toPlayer({ ...row, id: ids[i] }));
  });
  return out;
}
