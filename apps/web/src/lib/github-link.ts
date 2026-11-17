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
// Set of lowercased logins no account may link to: a deleted player's login
// stays out of reach of a new account, so its held PRs stay held. Outside
// `ctf:link:*` on purpose: a master reset wipes it (RESET_PREFIXES) and keeps
// every link.
export const RELINK_BLOCK_KEY = "ctf:relink:blocked";

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
 * KEYS[1] login key, KEYS[2] reverse pointer, KEYS[3] link-time hash, KEYS[4]
 * re-link blocklist; ARGV[1] user id, ARGV[2] lowercased login, ARGV[3]
 * login-key prefix, ARGV[4] epoch ms.
 * A blocked login is refused first, with nothing written, so a block holds
 * even against the player who last held it. The link time is written with a
 * link; `unchanged` keeps an existing time and only fills a missing one
 * (HSETNX), which can make a link look later, never earlier, so it cannot open
 * the close rule. `taken` and `blocked` write none. A login held by another
 * player is refused with nothing written; a renamed player's old login key is
 * deleted only while it still names them. Never deletes a link otherwise.
 */
export const LINK_SCRIPT = `
if redis.call('SISMEMBER', KEYS[4], ARGV[2]) == 1 then return 'blocked' end
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

/**
 * KEYS[1] reverse pointer, KEYS[2] link-time hash, KEYS[3] re-link blocklist;
 * ARGV[1] player id, ARGV[2] login-key prefix, ARGV[3] "1" to block the login.
 * Returns the released (lowercased) login, or nil when the player has no link.
 * The login key is derived inside the script from KEYS[1]'s value, as
 * LINK_SCRIPT does for the old login: reading the pointer outside the script
 * and passing the key in would race a concurrent re-link. The login key is
 * deleted, and the login blocked, only while that key names this player or is
 * absent, so a stale pointer can never release or block a login another player
 * now holds; the pointer and the link time go either way. Sync resolves a
 * released login to nobody and holds its scores.
 */
export const RELEASE_LINK_SCRIPT = `
local login = redis.call('GET', KEYS[1])
if not login then return false end
local key = ARGV[2] .. login
local holder = redis.call('GET', key)
local ours = holder == ARGV[1]
if ours then redis.call('DEL', key) end
redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[1])
if ARGV[3] == '1' and (ours or not holder) then redis.call('SADD', KEYS[3], login) end
return login
`;

export type LinkOutcome = "linked" | "unchanged" | "taken" | "blocked";

/** Records the GitHub login `userId` signed in with. Throws on a Redis error. */
export async function recordGithubSignIn(
  userId: string,
  login: string,
  prefix: string = LINK_GITHUB_PREFIX,
  userPrefix: string = LINK_USER_PREFIX,
  atKey: string = LINK_AT_KEY,
  blockKey: string = RELINK_BLOCK_KEY,
): Promise<LinkOutcome> {
  const lower = login.toLowerCase();
  const res = await upstashEval(
    LINK_SCRIPT,
    [`${prefix}${lower}`, `${userPrefix}${userId}`, atKey, blockKey],
    [userId, lower, prefix, String(Date.now())],
  );
  if (res !== "linked" && res !== "unchanged" && res !== "taken" && res !== "blocked") {
    throw new Error("github link: unexpected script reply");
  }
  return res;
}

/** Key overrides for the live suite; production uses the defaults. */
export type LinkKeys = { prefix?: string; userPrefix?: string; atKey?: string; blockKey?: string };

/**
 * Releases a player's GitHub link, and with `block` adds the login to the
 * re-link blocklist in the same script. Returns the released login (lowercased),
 * or null when the player had no link. Throws on a Redis error.
 */
export async function releaseGithubLink(playerId: string, opts: { block: boolean }, keys: LinkKeys = {}): Promise<string | null> {
  const { prefix = LINK_GITHUB_PREFIX, userPrefix = LINK_USER_PREFIX, atKey = LINK_AT_KEY, blockKey = RELINK_BLOCK_KEY } = keys;
  const res = await upstashEval(
    RELEASE_LINK_SCRIPT,
    [`${userPrefix}${playerId}`, atKey, blockKey],
    [playerId, prefix, opts.block ? "1" : "0"],
  );
  if (res === null) return null;
  if (typeof res !== "string" || res === "") throw new Error("github link: unexpected release reply");
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
 * with GitHub again or press Link GitHub on their profile again; a blocked
 * login stays refused until a master reset clears the blocklist. Log lines
 * carry neither login nor id.
 */
export async function linkOnUserWrite(user: { id?: unknown; login?: unknown } | null | undefined): Promise<void> {
  if (!user || typeof user.id !== "string" || typeof user.login !== "string" || user.login === "") return;
  try {
    const outcome = await recordGithubSignIn(user.id, user.login);
    if (outcome === "taken") console.error("[auth] github login already linked to another player");
    if (outcome === "blocked") console.error("[auth] github login is blocked from re-linking");
  } catch (err) {
    console.error(`[auth] could not record github link: ${errorLabel(err)}`);
  }
}
