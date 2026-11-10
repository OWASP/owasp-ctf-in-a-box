// Redis key layout for the better-auth store. The Lua scripts build index keys
// in this same format, so a change here must change them in lockstep.

export const AUTH_PREFIX = "ctf:auth";

// Fields with a secondary index (value -> row id). A lookup on any other
// field is a scan.
export const INDEXED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  user: ["email"],
  session: ["token", "userId"],
  account: ["userId", "accountId"],
  verification: ["identifier"],
};

export function rowsKey(prefix: string, model: string): string {
  return `${prefix}:${model}`;
}

export function indexKey(
  prefix: string,
  model: string,
  field: string,
  value: string,
): string {
  return `${prefix}:${model}:by:${field}:${value}`;
}
