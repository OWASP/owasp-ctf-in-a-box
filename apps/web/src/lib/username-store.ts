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
 * It writes through the database adapter, not `/update-user`, which stays
 * closed: that endpoint takes an arbitrary body. The stored `username` is the
 * normalized form the unique index and sign-in key on; `displayUsername` is
 * the trimmed input, held to the same rule as sign-up.
 *
 * "Once" is part of the write, not a read before it: the update matches the
 * user only while `username` is still null, and the Redis adapter's
 * compare-and-set re-checks that clause when it loses a race. So two picks
 * for one user (two tabs) cannot both win; the loser matches no row and gets
 * `already_set`. `internalAdapter.updateUser` matches on the id alone, which
 * is why it is not used; nothing it adds applies (no secondary storage, and
 * the username plugin's update hook only re-normalizes and pre-checks what
 * the unique index decides anyway).
 *
 * A username another user holds is refused by the adapter's unique index,
 * which names every unique field of the user model (email, username), not
 * the one that collided. This write changes only `username` and
 * `displayUsername`, so that refusal can only be the username: `taken`. The
 * username plugin's APIError coded USERNAME_IS_ALREADY_TAKEN maps the same
 * way. Any other failure throws (fail closed).
 */
export async function setUsernameOnce(userId: string, raw: string): Promise<SetUsernameResult> {
  if (usernameProblem(raw) !== null) return "invalid";
  const { adapter, internalAdapter } = await auth.$context;
  const user = await internalAdapter.findUserById(userId);
  if (!user) throw new Error("username: user not found");
  if ((user as { username?: string | null }).username) return "already_set";
  try {
    const updated = await adapter.update({
      model: "user",
      where: [
        { field: "id", value: userId },
        { field: "username", value: null },
      ],
      update: { username: normalizeUsername(raw), displayUsername: raw.trim(), updatedAt: new Date() },
    });
    return updated ? "ok" : "already_set";
  } catch (err) {
    if (isTakenError(err)) return "taken";
    throw err;
  }
}

export type RenameUsernameResult = "ok" | "taken" | "invalid" | "missing";

/**
 * An organizer's rename: replaces the username of the user `userId`, whatever
 * it held before. Same rule and the same two stored forms as
 * `setUsernameOnce`, but the write matches on the id alone, so there is no
 * `already_set`: no row matched is `missing`.
 *
 * Renaming to the same name in another case matches the user's own row in the
 * unique index (`Alice` to `alice` only changes `displayUsername`); another
 * user's name is `taken` in any case. Any other failure throws (fail closed).
 */
export async function renameUsername(userId: string, raw: string): Promise<RenameUsernameResult> {
  if (usernameProblem(raw) !== null) return "invalid";
  const { adapter } = await auth.$context;
  try {
    const updated = await adapter.update({
      model: "user",
      where: [{ field: "id", value: userId }],
      update: { username: normalizeUsername(raw), displayUsername: raw.trim(), updatedAt: new Date() },
    });
    return updated ? "ok" : "missing";
  } catch (err) {
    if (isTakenError(err)) return "taken";
    throw err;
  }
}

/** The stored (normalized) username, or null when the user has none or does
 *  not exist. A read error throws. */
export async function currentUsername(userId: string): Promise<string | null> {
  const { internalAdapter } = await auth.$context;
  const user = await internalAdapter.findUserById(userId);
  return (user as { username?: string | null } | null)?.username ?? null;
}

/** True when the user has a username-and-password (`credential`) account.
 *  A read error throws: callers decide their own fail direction. */
export async function hasPassword(userId: string): Promise<boolean> {
  const { internalAdapter } = await auth.$context;
  const accounts = await internalAdapter.findAccounts(userId);
  return accounts.some((a) => a.providerId === "credential");
}
