// Audit actors for tests: the shape every admin write is attributed to (a
// player id and a display name, see AuditActor in admin-audit-keys.ts).

/** A fixed actor per name, with a valid player id derived from the name so
 *  two names never share an id. */
export function actor(name: string): { id: string; name: string } {
  const hex = [...name].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(12, "0").slice(0, 12);
  return { id: `00000000-0000-4000-8000-${hex}`, name };
}

export const ALICE = actor("alice");
