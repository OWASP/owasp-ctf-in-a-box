import { upstashPipeline } from "@/lib/upstash";

/**
 * The READ half of the admin roster, in its own module because it sits on the
 * authorization path (`admin-auth.ts`): importing `admin-store.ts` here would
 * pull the whole admin surface, and the module registry behind it, into every
 * gated route. The writers (claim, issue, revoke) live in `admin-claim.ts`.
 *
 * Every read THROWS on a failed command or an error reply: read as "no grant"
 * it would deny for the wrong reason, and the caller owns the fail direction
 * (`requireAdmin` turns a throw into a 403).
 */

/** The only admin roster: a SET of kit player ids. Under `ctf:admin:`, which no
 *  master-reset pattern matches, so a reset never locks the organizers out. */
export const ADMIN_GRANTS_KEY = "ctf:admin:grants";

/** Player ids holding a grant, sorted. */
export async function listAdminGrants(): Promise<string[]> {
  const [res] = await upstashPipeline([["SMEMBERS", ADMIN_GRANTS_KEY]]);
  if (!res || res.error) throw new Error(`Upstash SMEMBERS admin grants failed: ${res?.error ?? "no reply"}`);
  const arr = Array.isArray(res.result) ? res.result : [];
  return arr.map((a) => String(a)).sort();
}

/** True when `playerId` holds a grant. */
export async function isAdminGrantee(playerId: string): Promise<boolean> {
  const [res] = await upstashPipeline([["SISMEMBER", ADMIN_GRANTS_KEY, playerId]]);
  if (!res || res.error) throw new Error(`Upstash SISMEMBER admin grants failed: ${res?.error ?? "no reply"}`);
  return Number(res.result) === 1;
}

/** How many grants exist. */
export async function countAdminGrants(): Promise<number> {
  const [res] = await upstashPipeline([["SCARD", ADMIN_GRANTS_KEY]]);
  if (!res || res.error) throw new Error(`Upstash SCARD admin grants failed: ${res?.error ?? "no reply"}`);
  return Number(res.result) || 0;
}
