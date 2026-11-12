// The display-name rule, shared by server code and client components (the nav
// reads the session user with it), so it imports nothing server-only.

export type NameParts = { id: string; username?: string | null; login?: string | null; name?: string | null };

/**
 * The name shown for a player: username, then GitHub login, then profile name,
 * then a short id so a row is never blank.
 */
export function displayNameOf(row: NameParts): string {
  return row.username || row.login || row.name || `player ${row.id.slice(0, 8)}`;
}

/** The name and image a row carries before profiles are read: the id fallback
 *  and no image. The leaderboard's naming stage replaces both from the
 *  player's profile when one exists. */
export function unnamed(id: string): { name: string; image: string | null } {
  return { name: displayNameOf({ id }), image: null };
}
