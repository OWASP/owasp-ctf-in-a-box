const LINK_ERROR_COPY: Record<string, string> = {
  account_already_linked_to_different_user: "That GitHub account is already linked to another player.",
  unable_to_link_account:
    "Couldn't link that GitHub account. Check that its primary email is verified on GitHub, then try again.",
};

const GENERIC_LINK_ERROR = "Linking GitHub didn't finish. Try again.";
const UNFINISHED_LINK = "Linking GitHub didn't finish. Press Link GitHub account again.";

/** The message for a player returning from the GitHub link round-trip, or
 *  null. `error` is an attacker-controlled query value: only an own key of
 *  LINK_ERROR_COPY ever selects specific copy and the raw value is never
 *  rendered. A `linked=github` return with no stored link is treated as a
 *  half-done link, because better-auth's success redirect proves nothing
 *  about the kit's own record. */
export function linkNotice(error: string | undefined, linked: string | undefined, isLinked: boolean): string | null {
  if (error) return Object.hasOwn(LINK_ERROR_COPY, error) ? LINK_ERROR_COPY[error] : GENERIC_LINK_ERROR;
  if (linked === "github" && !isLinked) return UNFINISHED_LINK;
  return null;
}
