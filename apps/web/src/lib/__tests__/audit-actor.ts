// Audit actors for tests: the shape every admin write is attributed to (a
// player id and a display name, see AuditActor in admin-audit-keys.ts).

import { createHash } from "node:crypto";

/** A fixed actor per name, with a valid player id whose last group is the
 *  first 12 hex digits of the full name's sha256, so names sharing a prefix
 *  still get distinct ids. */
export function actor(name: string): { id: string; name: string } {
  const hex = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return { id: `00000000-0000-4000-8000-${hex}`, name };
}

export const ALICE = actor("alice");
