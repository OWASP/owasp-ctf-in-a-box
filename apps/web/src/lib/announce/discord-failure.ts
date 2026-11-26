// What a failed Discord post means, in an organizer's words. Send test and
// the Discord card's status line both show it, so an organizer reads "the
// webhook was deleted" rather than a bare 502. Dependency-free and
// client-safe; it never sees the webhook URL, which is a bearer secret.

/** A failed post as the sender saw it: the HTTP status Discord answered, or
 *  none when the request never got an answer (network error, timeout). */
export type DiscordFailure = { httpStatus?: number };

export function describeDiscordFailure({ httpStatus }: DiscordFailure): string {
  if (httpStatus === undefined) return "Could not reach Discord (network error or timeout)";
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
    return `Discord rejected the webhook (${httpStatus}): the URL is wrong or the webhook was deleted`;
  }
  if (httpStatus >= 500) return `Discord answered ${httpStatus}: a problem on Discord's side; try again shortly`;
  return `Discord rejected the post (${httpStatus})`;
}
