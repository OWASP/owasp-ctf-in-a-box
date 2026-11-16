import "server-only";

import { auth } from "@/lib/auth";
import { normalizeUsername, usernameProblem } from "@/lib/username-rules";

export type SetUsernameResult = "ok" | "taken" | "already_set" | "invalid";

/** The adapter's unique-index refusal: `auth store: update user failed:
 *  unique email, username taken`. */
const UNIQUE_TAKEN_RE = /\bunique\b.*\btaken\b/;

function isTakenError(err: unknown): boolean {
  if ((err as { body?: { code?: unknown } } | null)?.body?.code === "USERNAME_IS_ALREADY_TAKEN") return true;
  return err instanceof Error && UNIQUE_TAKEN_RE.test(err.message);
}

/**
 * Sets the username of a user who has none (a first OAuth sign-in), once.
 *
 * It goes through the internal adapter, not `/update-user`, which stays
 * closed: that endpoint takes an arbitrary body. The stored `username` is the
 * normalized form the unique index and sign-in key on; `displayUsername` is
 * the trimmed input, held to the same rule as sign-up.
 *
 * A username someone already holds is refused on two paths, both `taken`. The
 * username plugin's update hook looks it up first and throws an APIError
 * coded USERNAME_IS_ALREADY_TAKEN; two picks racing past that lookup meet the
 * adapter's unique-index refusal, which lists every unique field of the user
 * model (email, username), not the one that collided. This write changes only
 * `username` and `displayUsername`, so that refusal can only be the username.
 * Any other failure throws (fail closed).
 */
export async function setUsernameOnce(userId: string, raw: string): Promise<SetUsernameResult> {
  if (usernameProblem(raw) !== null) return "invalid";
  const { internalAdapter } = await auth.$context;
  const user = await internalAdapter.findUserById(userId);
  if (!user) throw new Error("username: user not found");
  if ((user as { username?: string | null }).username) return "already_set";
  try {
    await internalAdapter.updateUser(userId, { username: normalizeUsername(raw), displayUsername: raw.trim() });
    return "ok";
  } catch (err) {
    if (isTakenError(err)) return "taken";
    throw err;
  }
}

/** True when the user has a username-and-password (`credential`) account.
 *  A read error throws: callers decide their own fail direction. */
export async function hasPassword(userId: string): Promise<boolean> {
  const { internalAdapter } = await auth.$context;
  const accounts = await internalAdapter.findAccounts(userId);
  return accounts.some((a) => a.providerId === "credential");
}
