import { describe, expect, it } from "vitest";
import type { CleanedWhere } from "better-auth/adapters";
import { indexLookup, matchesWhere, sortAndPage } from "@/lib/auth-store/where";
import { indexKey, rowsKey } from "@/lib/auth-store/keys";

function w(
  field: string,
  value: unknown,
  extra: Partial<CleanedWhere> = {},
): CleanedWhere {
  return {
    field,
    value,
    operator: "eq",
    connector: "AND",
    mode: "sensitive",
    ...extra,
  } as CleanedWhere;
}

describe("keys", () => {
  it("lays out rows and index keys", () => {
    expect(rowsKey("ctf:auth", "user")).toBe("ctf:auth:user");
    expect(indexKey("ctf:auth", "session", "token", "t1")).toBe(
      "ctf:auth:session:by:token:t1",
    );
  });
});

describe("matchesWhere", () => {
  const row = { id: "u1", email: "Ada@Example.org", n: 3, tags: ["a"] };
  it("defaults to eq and AND", () => {
    expect(matchesWhere(row, [w("email", "Ada@Example.org"), w("n", 3)])).toBe(true);
    expect(matchesWhere(row, [w("email", "Ada@Example.org"), w("n", 4)])).toBe(false);
  });
  it("honours OR connectors", () => {
    expect(matchesWhere(row, [w("n", 9), w("id", "u1", { connector: "OR" })])).toBe(true);
  });
  it("compares case-insensitively only in insensitive mode", () => {
    expect(matchesWhere(row, [w("email", "ada@example.org")])).toBe(false);
    expect(
      matchesWhere(row, [w("email", "ada@example.org", { mode: "insensitive" })]),
    ).toBe(true);
  });
  it.each([
    ["ne", 4, true],
    ["lt", 4, true],
    ["lte", 3, true],
    ["gt", 3, false],
    ["gte", 3, true],
    ["in", [1, 3], true],
    ["not_in", [3], false],
  ])("operator %s", (operator, value, expected) => {
    expect(
      matchesWhere(row, [w("n", value, { operator: operator as CleanedWhere["operator"] })]),
    ).toBe(expected);
  });
  it("contains / starts_with / ends_with on strings", () => {
    expect(matchesWhere(row, [w("email", "Example", { operator: "contains" })])).toBe(true);
    expect(matchesWhere(row, [w("email", "Ada", { operator: "starts_with" })])).toBe(true);
    expect(matchesWhere(row, [w("email", ".org", { operator: "ends_with" })])).toBe(true);
  });
  it("treats a missing field as null", () => {
    expect(matchesWhere(row, [w("image", null)])).toBe(true);
  });
  it("is false for string operators on a non-string row value", () => {
    expect(matchesWhere(row, [w("n", "3", { operator: "contains" })])).toBe(false);
  });
  it("lowercases in/not_in strings in insensitive mode", () => {
    expect(
      matchesWhere(row, [
        w("email", ["ADA@example.org"], { operator: "in", mode: "insensitive" }),
      ]),
    ).toBe(true);
    expect(
      matchesWhere(row, [
        w("email", ["ADA@example.org"], { operator: "not_in", mode: "insensitive" }),
      ]),
    ).toBe(false);
  });
  it("compares dates by time", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(
      matchesWhere({ at: d }, [w("at", new Date("2026-01-01T00:00:00Z"))]),
    ).toBe(true);
    expect(
      matchesWhere({ at: d }, [w("at", new Date("2026-02-01T00:00:00Z"), { operator: "lt" })]),
    ).toBe(true);
  });
  it("matches everything for an empty where", () => {
    expect(matchesWhere(row, [])).toBe(true);
  });
});

describe("indexLookup", () => {
  it("uses a sensitive eq on an indexed field", () => {
    expect(indexLookup("session", [w("token", "t1")])).toEqual({ field: "token", value: "t1" });
  });
  it("scans for an OR, an insensitive match or an unindexed field", () => {
    expect(
      indexLookup("session", [w("token", "t1"), w("userId", "u", { connector: "OR" })]),
    ).toBeNull();
    expect(indexLookup("user", [w("email", "a@b", { mode: "insensitive" })])).toBeNull();
    expect(indexLookup("user", [w("name", "Ada")])).toBeNull();
  });
  it("skips non-string values", () => {
    expect(indexLookup("session", [w("token", 5)])).toBeNull();
  });
});

describe("sortAndPage", () => {
  it("sorts, then offsets, then limits", () => {
    const rows = [{ n: 2 }, { n: 1 }, { n: 3 }];
    expect(
      sortAndPage(rows, { sortBy: { field: "n", direction: "desc" }, offset: 1, limit: 1 }),
    ).toEqual([{ n: 2 }]);
  });
  it("does not mutate its input", () => {
    const rows = [{ n: 2 }, { n: 1 }];
    sortAndPage(rows, { sortBy: { field: "n", direction: "asc" } });
    expect(rows).toEqual([{ n: 2 }, { n: 1 }]);
  });
});
