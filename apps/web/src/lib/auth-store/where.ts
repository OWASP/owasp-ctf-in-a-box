// Pure where-clause evaluation for the Redis-backed better-auth adapter.
// No server-only import: this file is test-importable.
import type { CleanedWhere } from "better-auth/adapters";
import { INDEXED_FIELDS } from "./keys";

function norm(v: unknown, insensitive: boolean): unknown {
  if (v instanceof Date) return v.getTime();
  if (insensitive && typeof v === "string") return v.toLowerCase();
  return v;
}

function matchesOne(row: Record<string, unknown>, c: CleanedWhere): boolean {
  const insensitive = c.mode === "insensitive";
  const rowRaw = row[c.field] ?? null;
  const rv = norm(rowRaw, insensitive);
  const cv = norm(c.value, insensitive);

  switch (c.operator) {
    case "eq":
      return rv === cv;
    case "ne":
      return rv !== cv;
    case "lt":
      return rv !== null && cv !== null && (rv as number) < (cv as number);
    case "lte":
      return rv !== null && cv !== null && (rv as number) <= (cv as number);
    case "gt":
      return rv !== null && cv !== null && (rv as number) > (cv as number);
    case "gte":
      return rv !== null && cv !== null && (rv as number) >= (cv as number);
    case "in":
    case "not_in": {
      const list = Array.isArray(c.value)
        ? c.value.map((x) => norm(x, insensitive))
        : [];
      const found = list.includes(rv);
      return c.operator === "in" ? found : !found;
    }
    case "contains":
      return typeof rv === "string" && typeof cv === "string" && rv.includes(cv);
    case "starts_with":
      return typeof rv === "string" && typeof cv === "string" && rv.startsWith(cv);
    case "ends_with":
      return typeof rv === "string" && typeof cv === "string" && rv.endsWith(cv);
    default:
      return false;
  }
}

// Clauses fold left to right, each joined to the running result by its own
// connector (the semantics of better-auth's other adapters).
export function matchesWhere(
  row: Record<string, unknown>,
  where: CleanedWhere[],
): boolean {
  if (where.length === 0) return true;
  let result = matchesOne(row, where[0]);
  for (let i = 1; i < where.length; i++) {
    const hit = matchesOne(row, where[i]);
    result = where[i].connector === "OR" ? result || hit : result && hit;
  }
  return result;
}

// An index answers only a pure-AND, case-sensitive equality on a string
// value; anything else must scan.
export function indexLookup(
  model: string,
  where: CleanedWhere[],
): { field: string; value: string } | null {
  if (where.some((c) => c.connector === "OR")) return null;
  const indexed = INDEXED_FIELDS[model] ?? [];
  for (const c of where) {
    if (
      c.operator === "eq" &&
      c.mode === "sensitive" &&
      typeof c.value === "string" &&
      indexed.includes(c.field)
    ) {
      return { field: c.field, value: c.value };
    }
  }
  return null;
}

// Row ids are the rows hash's fields, so a pure-AND, case-sensitive `id eq`
// or `id in` over strings names its candidate rows directly. The caller still
// filters them through the full where clause.
export function idLookup(where: CleanedWhere[]): string[] | null {
  if (where.some((c) => c.connector === "OR")) return null;
  for (const c of where) {
    if (c.field !== "id" || c.mode !== "sensitive") continue;
    if (c.operator === "eq" && typeof c.value === "string") return [c.value];
    if (c.operator === "in" && Array.isArray(c.value) && c.value.every((v) => typeof v === "string")) {
      return [...new Set(c.value as string[])];
    }
  }
  return null;
}

function cmp(a: unknown, b: unknown): number {
  const x = norm(a ?? null, false);
  const y = norm(b ?? null, false);
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return (x as number) < (y as number) ? -1 : 1;
}

export function sortAndPage<T extends Record<string, unknown>>(
  rows: T[],
  opts: {
    sortBy?: { field: string; direction: "asc" | "desc" };
    offset?: number;
    limit?: number;
  },
): T[] {
  let out = rows.slice();
  if (opts.sortBy) {
    const { field, direction } = opts.sortBy;
    const sign = direction === "desc" ? -1 : 1;
    out.sort((a, b) => sign * cmp(a[field], b[field]));
  }
  const start = opts.offset ?? 0;
  out = opts.limit === undefined ? out.slice(start) : out.slice(start, start + opts.limit);
  return out;
}
