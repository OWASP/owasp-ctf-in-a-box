import "server-only";

import { errorLabel } from "@/lib/error-label";
import { upstashEval, upstashPipeline } from "@/lib/upstash";

// A GitHub login claims a kit player: `ctf:link:github:<login>` holds the
// player id and `ctf:link:user:<id>` holds the login that player last signed
// in with, so a rename can release the old login key. Both sit outside every
// master-reset prefix (RESET_PREFIXES): links are account data, like `ctf:auth:`.
export const LINK_GITHUB_PREFIX = "ctf:link:github:";
export const LINK_USER_PREFIX = "ctf:link:user:";

export function linkKey(login: string): string {
  return `${LINK_GITHUB_PREFIX}${login.toLowerCase()}`;
}

/**
 * KEYS[1] login key, KEYS[2] reverse pointer; ARGV[1] user id, ARGV[2]
 * lowercased login, ARGV[3] login-key prefix. A login held by another player
 * is refused with nothing written; a renamed player's old login key is
 * deleted only while it still names them. Never deletes a link otherwise.
 */
export const LINK_SCRIPT = `
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= ARGV[1] then return 'taken' end
local prev = redis.call('GET', KEYS[2])
if owner == ARGV[1] and prev == ARGV[2] then return 'unchanged' end
if prev and prev ~= ARGV[2] then
  local old = ARGV[3] .. prev
  if redis.call('GET', old) == ARGV[1] then redis.call('DEL', old) end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 'linked'
`;

export type LinkOutcome = "linked" | "unchanged" | "taken";

/** Records the GitHub login `userId` signed in with. Throws on a Redis error. */
export async function recordGithubSignIn(
  userId: string,
  login: string,
  prefix: string = LINK_GITHUB_PREFIX,
  userPrefix: string = LINK_USER_PREFIX,
): Promise<LinkOutcome> {
  const lower = login.toLowerCase();
  const res = await upstashEval(
    LINK_SCRIPT,
    [`${prefix}${lower}`, `${userPrefix}${userId}`],
    [userId, lower, prefix],
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

/**
 * The better-auth user create/update `after` hook body. A GitHub sign-in
 * writes the user row (create, or update via overrideUserInfoOnSignIn), so this
 * runs on every sign-in with the login GitHub just reported. It never fails
 * the sign-in: a refused or errored link leaves the player unattributed until
 * their next sign-in. Log lines carry neither login nor id.
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
