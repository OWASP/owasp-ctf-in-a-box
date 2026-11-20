// The shared admin audit trail's key and retention cap, split from
// admin-store.ts (#504 M9) so lib/demo-seed.ts can append to the SAME trail
// every admin write appends to without importing admin-store back — that
// module holds the settings read the seed is handed, and the import in the
// other direction is the cycle `module-defaults.ts` exists to avoid.
//
// Dependency-free by contract, the one activity-keys.ts keeps: a key name and
// a number, nothing that pulls in `server-only` or Upstash. admin-store
// re-exports both, so its callers keep one import.

/** One Redis LIST of the shared audit entries, newest first (LPUSH). Every
 *  admin authoring route and every dangerous-settings action appends here. */
export const ADMIN_AUDIT_KEY = "ctf:admin:audit";

/** Entries kept on that list. Trimmed on every write, so it is bounded by
 *  construction — the same retention policy ACTIVITY_LOG_MAX sets for the
 *  contestant-facing log. */
export const AUDIT_CAP = 500;

/** Who an audit entry is by: the admin's player id, which is what the entry
 *  keys on, and their display name at the time, so the entry still reads
 *  after a rename or after the account is gone. A `Player` fits this shape;
 *  writers copy these two fields and nothing else. */
export type AuditActor = { id: string; name: string };

/** The audit actor for a signed-in admin: exactly the id and name, so a
 *  `Player`'s other fields (its GitHub login among them) never reach a line. */
export function auditActor(who: AuditActor): AuditActor {
  return { id: who.id, name: who.name };
}
