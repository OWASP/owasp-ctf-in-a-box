import "server-only";

import { errorLabel } from "@/lib/error-label";
import { upstashEval, upstashPipeline } from "@/lib/upstash";

// A GitHub login claims a kit player: `ctf:link:github:<login>` holds the
// player id and `ctf:link:user:<id>` holds the login that player last signed
// in with, so a rename can release the old login key. Both sit outside every
// master-reset prefix (RESET_PREFIXES): links are account data, like `ctf:auth:`.
export const LINK_GITHUB_PREFIX = "ctf:link:github:";
export const LINK_USER_PREFIX = "ctf:link:user:";
// Hash: field = player id, value = epoch ms of the last write to that player's
// link. Sync reads it (HGET) to tell whether an author linked before scoring closed.
export const LINK_AT_KEY = "ctf:link:at";

/** A stored link time, or null for anything but a safe decimal integer.
 *  Same rule as `resolveGithubLink` in sync/src/redis.js: a null time counts
 *  as linked after the close, so a stray value can never read as an early link. */
export function parseLinkAt(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) ? ms : null;
}

export function linkKey(login: string): string {
  return `${LINK_GITHUB_PREFIX}${login.toLowerCase()}`;
}

/**
 * KEYS[1] login key, KEYS[2] reverse pointer, KEYS[3] link-time hash; ARGV[1]
 * user id, ARGV[2] lowercased login, ARGV[3] login-key prefix, ARGV[4] epoch ms.
 * The link time is written with a link; `unchanged` keeps an existing time and
 * only fills a missing one (HSETNX), which can make a link look later, never
 * earlier, so it cannot open the close rule. `taken` writes none. A login held by another player
 * is refused with nothing written; a renamed player's old login key is
 * deleted only while it still names them. Never deletes a link otherwise.
 */
export const LINK_SCRIPT = `
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= ARGV[1] then return 'taken' end
local prev = redis.call('GET', KEYS[2])
if owner == ARGV[1] and prev == ARGV[2] then
  redis.call('HSETNX', KEYS[3], ARGV[1], ARGV[4])
  return 'unchanged'
end
if prev and prev ~= ARGV[2] then
  local old = ARGV[3] .. prev
  if redis.call('GET', old) == ARGV[1] then redis.call('DEL', old) end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
return 'linked'
`;

export type LinkOutcome = "linked" | "unchanged" | "taken";

/** Records the GitHub login `userId` signed in with. Throws on a Redis error. */
export async function recordGithubSignIn(
  userId: string,
  login: string,
  prefix: string = LINK_GITHUB_PREFIX,
  userPrefix: string = LINK_USER_PREFIX,
  atKey: string = LINK_AT_KEY,
): Promise<LinkOutcome> {
  const lower = login.toLowerCase();
  const res = await upstashEval(
    LINK_SCRIPT,
    [`${prefix}${lower}`, `${userPrefix}${userId}`, atKey],
    [userId, lower, prefix, String(Date.now())],
  );
  if (res !== "linked" && res !== "unchanged" && res !== "taken") throw new Error("github link: unexpected script reply");
  return res;
}

/** The player id a GitHub login is linked to, or null. Throws on a command error. */
export async function resolveGithubLogin(login: string, prefix: string = LINK_GITHUB_PREFIX): Promise<string | null> {
  const [reply] = await upstashPipeline([["GET", `${prefix}${login.toLowerCase()}`]]);
  if (!reply || reply.error) throw new Error(`github link: GET failed: ${reply?.error ?? "no reply"}`);
  return typeof reply.result === "string" ? reply.result : null;
}

/** The login a player is linked to and when it was linked, or null. Throws on a command error. */
export async function getGithubLink(
  playerId: string,
  userPrefix: string = LINK_USER_PREFIX,
  atKey: string = LINK_AT_KEY,
): Promise<{ login: string; linkedAt: number | null } | null> {
  const [user, at] = await upstashPipeline([
    ["GET", `${userPrefix}${playerId}`],
    ["HGET", atKey, playerId],
  ]);
  if (!user || user.error) throw new Error(`github link: GET failed: ${user?.error ?? "no reply"}`);
  if (!at || at.error) throw new Error(`github link: HGET failed: ${at?.error ?? "no reply"}`);
  if (typeof user.result !== "string") return null;
  return { login: user.result, linkedAt: parseLinkAt(at.result) };
}

/**
 * The better-auth user create/update `after` hook body. A GitHub sign-in
 * writes the user row (create, or update via overrideUserInfoOnSignIn), so this
 * runs on every sign-in with the login GitHub just reported, and on a link from
 * the profile (updateUserInfoOnLink). It never fails the sign-in or the link: a
 * refused or errored link leaves the player unattributed until they sign in
 * with GitHub again or press Link GitHub on their profile again. Log lines
 * carry neither login nor id.
 */
export async function linkOnUserWrite(user: { id?: unknown; login?: unknown } | null | undefined): Promise<void> {
  if (!user || typeof user.id !== "string" || typeof user.login !== "string" || user.login === "") return;
  try {
    if ((await recordGithubSignIn(user.id, user.login)) === "taken") {
      console.error("[auth] github login already linked to another player");
    }
  } catch (err) {
    console.error(`[auth] could not record github link: ${errorLabel(err)}`);
  }
}
