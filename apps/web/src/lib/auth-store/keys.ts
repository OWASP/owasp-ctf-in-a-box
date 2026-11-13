// Redis key layout for the better-auth store. The Lua scripts build index keys
// in this same format, so a change here must change them in lockstep.

export const AUTH_PREFIX = "ctf:auth";

// Fields with a secondary index (value -> row id). A lookup on any other
// field is a scan, except `id`, which is the rows hash's own field.
//
// A name joining fields with "+" is a composite index whose value is the
// parts joined with ":" (`providerId+accountId` -> `github:42`); it exists only
// to enforce uniqueness, never to answer a where clause. The value is
// unambiguous because no provider id contains ":".
export const INDEXED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  user: ["email"],
  session: ["token", "userId"],
  account: ["userId", "accountId", "providerId+accountId"],
  verification: ["identifier"],
};

// Indexed fields no two rows may share. A write whose value is already held
// by another live row writes nothing (PUT_ROW_SCRIPT returns 2), so two
// concurrent first sign-ins cannot leave duplicate users or accounts behind:
// better-auth's findAccountOwnerByKey refuses every later sign-in once two
// accounts share an accountId.
export const UNIQUE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  user: ["email"],
  account: ["providerId+accountId"],
};

/**
 * Key of the hash holding every row of `model`, by row id.
 */
export function rowsKey(prefix: string, model: string): string {
  return `${prefix}:${model}`;
}

/**
 * Key of the set of row ids whose indexed `field` equals `value`.
 */
export function indexKey(
  prefix: string,
  model: string,
  field: string,
  value: string,
): string {
  return `${prefix}:${model}:by:${field}:${value}`;
}

/**
 * Key holding the token of the transaction that created row `id` of `model`.
 * PUT_ROW_SCRIPT sets it with a TTL when that create writes the row, every
 * delete removes it, and a failed transaction's undo deletes the row only
 * while it still holds that transaction's token.
 */
export function ownerKey(prefix: string, model: string, id: string): string {
  return `${prefix}:${model}:owner:${id}`;
}
