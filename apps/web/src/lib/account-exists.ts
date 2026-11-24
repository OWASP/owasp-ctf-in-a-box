import "server-only";

import { AUTH_PREFIX, rowsKey } from "@/lib/auth-store/keys";
import { upstashPipeline } from "@/lib/upstash";

/**
 * Whether the account row for `id` still exists in Redis.
 *
 * A session is trusted from better-auth's signed cookie cache for up to
 * `cookieCache.maxAge` without reading Redis, so a player an organizer has
 * just deleted still passes `getPlayer` on that device until it expires.
 * Writes ask this first. Throws on a command error, so a write fails closed
 * rather than acting for an account it could not confirm.
 */
export async function accountExists(id: string, prefix: string = AUTH_PREFIX): Promise<boolean> {
  const [reply] = await upstashPipeline([["HEXISTS", rowsKey(prefix, "user"), id]]);
  if (!reply || reply.error) throw new Error(`account exists: HEXISTS failed: ${reply?.error ?? "no reply"}`);
  return reply.result === 1;
}
