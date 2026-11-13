import "server-only";
import { getPlayer, type Player } from "@/lib/player";
import { envAdmins } from "@/lib/bootstrap-env";
import { listStoredAdmins } from "@/lib/admin-admins";

/** Admins from `ADMIN_LOGINS` (config v2 — no more baked `event.yaml`
 *  `admins:` array). These are the BOOTSTRAP identities: they always
 *  authorize, they cannot be revoked through the panel, and they are the
 *  recovery path if a runtime grant goes wrong or Redis is empty. Changing
 *  them needs an env edit and a restart — which is the whole reason runtime
 *  grants exist (issue #147; ADR 44 records the recovery path this set is
 *  for). Computed once at module load: `ADMIN_LOGINS` is process
 *  configuration, not something that changes without a restart, same as
 *  the baked set it replaces. */
const envAdminSet = envAdmins();

/** True for a login in `ADMIN_LOGINS`. Synchronous and Redis-free, so it is
 *  safe anywhere — including the paths that only need "is this the
 *  organizer" for display. */
export function isEnvAdmin(login: string | undefined): boolean {
  return typeof login === "string" && envAdminSet.has(login.toLowerCase());
}

/** Env admins, lowercased and sorted. The panel needs them to mark which
 *  rows it must refuse to remove, and to know when the allowlist itself is
 *  empty (see `isAdminLogin`'s fail-closed note). */
export function listEnvAdmins(): string[] {
  return [...envAdminSet].sort();
}

/**
 * True when `login` is an admin — in `ADMIN_LOGINS` OR granted at runtime.
 *
 * FAIL CLOSED, two ways. First, the ordinary one: a Redis error propagates
 * rather than resolving false-y by accident, and `requireAdmin` turns it
 * into a 403. This is deliberately the OPPOSITE of `effectivePaused`'s read
 * in admin-store, which fails OPEN so a Redis blip cannot drop live
 * submissions: that one is a safety switch whose failure should not stop an
 * event, and this one is an access check whose failure must not grant
 * access. Both behaviours are correct; they differ because the cost of
 * being wrong differs.
 *
 * Second, the config-v2-specific one: when `ADMIN_LOGINS` is EMPTY, nobody
 * is an admin, full stop — a runtime grant is refused too. The alternative
 * (empty allowlist = "no restriction configured, let runtime grants
 * decide") would make the panel reachable to whoever grants themselves
 * first, on a value that reads at a glance like "nobody"; refusing
 * everyone is the only answer this repo trusts to type correctly. This is
 * why the empty-set check happens BEFORE the Redis read, not after: it also
 * means the fail-closed path never touches Redis at all.
 *
 * An env admin short-circuits before Redis is touched, so the organizer can
 * still get in when the datastore is down — which is exactly when they most
 * need the panel.
 */
export async function isAdminLogin(login: string | undefined): Promise<boolean> {
  if (typeof login !== "string" || login === "") return false;
  if (isEnvAdmin(login)) return true;
  if (envAdminSet.size === 0) return false;
  const stored = await listStoredAdmins();
  return stored.includes(login.toLowerCase());
}

/**
 * The signed-in admin. Admin-ness is decided on the GitHub `login` attribute
 * (`ADMIN_LOGINS` and runtime grants name logins); `player` is who they are
 * to every store and audit line.
 */
export async function requireAdmin(
  headers: Headers,
): Promise<{ ok: true; player: Player; login: string } | { ok: false; status: 401 | 403 }> {
  const player = await getPlayer(headers);
  if (!player) return { ok: false, status: 401 };
  const login = player.githubLogin;
  if (typeof login !== "string" || login === "") return { ok: false, status: 403 };
  if (isEnvAdmin(login)) return { ok: true, player, login };
  // Fail closed: an empty ADMIN_LOGINS refuses everyone, runtime grants
  // included — see isAdminLogin's comment. Checked before the Redis read so
  // the fail-closed path needs no store at all.
  if (envAdminSet.size === 0) return { ok: false, status: 403 };
  let stored: string[];
  try {
    stored = await listStoredAdmins();
  } catch {
    // Fail closed: an unreachable datastore denies, it does not grant. The
    // env-admin check above already ran, so a login in ADMIN_LOGINS is
    // unaffected by this branch.
    return { ok: false, status: 403 };
  }
  if (!stored.includes(login.toLowerCase())) return { ok: false, status: 403 };
  return { ok: true, player, login };
}
