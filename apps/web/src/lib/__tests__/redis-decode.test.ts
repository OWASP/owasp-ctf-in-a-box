// The store-side decode helpers and the Lua attempt-row read (#504 M13).
//
// quiz, classic and ai each carried their own byte-identical copy of
// `parseJsonValue` / `parseHashEntries` / `parseCounterHash`, and each grading
// script carried its own copy of the attempt-row read. Three copies is three
// places for the next change to land in one and silently desync the others:
// the parsers decide what a corrupt row reads as (a whole module's points can
// go missing), and the Lua read decides what the attempt budget and the
// cooldown are measured against.
//
// These assertions are about the SOURCE, not the output: a dedup has no
// behaviour to re-assert (the stores' own suites cover the behaviour), so what
// has to be pinned is that there is exactly ONE implementation left. Read from
// disk rather than imported, because the claim is about which file spells the
// code, which a module import cannot tell you.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ATTEMPT_ROW_LUA, parseCounterHash, parseHashEntries, parseJsonValue } from "@/lib/redis-decode";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORES = ["quiz-store.ts", "classic-store.ts", "ai-store.ts"].map((f) => join(LIB, f));
const read = (path: string): string => readFileSync(path, "utf8");

describe("the store parse helpers have one implementation", () => {
  it("lives in lib/redis-decode.ts, next to the stores that share it", () => {
    expect(existsSync(join(LIB, "redis-decode.ts"))).toBe(true);
  });

  for (const path of STORES) {
    const name = path.slice(path.lastIndexOf("/") + 1);

    it(`${name} imports the parsers instead of declaring them`, () => {
      const src = read(path);
      expect(src).toContain('from "@/lib/redis-decode"');
      // The declarations, not the call sites — a call is fine, a second body
      // is the drift this closes.
      expect(src).not.toMatch(/^function parseJsonValue\b/m);
      expect(src).not.toMatch(/^function parseHashEntries\b/m);
      expect(src).not.toMatch(/^function parseCounterHash\b/m);
    });
  }

  it("walks a flat HGETALL reply, keeping only rows the extractor accepts", () => {
    const rows = ["a", '{"points":10,"at":"2026-01-01T00:00:00.000Z"}', "b", "not json", "c", "12"];
    const extract = (v: Record<string, unknown>): { points: number } | null =>
      typeof v.points === "number" ? { points: v.points } : null;
    expect(parseHashEntries(rows, extract)).toEqual({ a: { points: 10 } });
    // Non-array input reads as "no rows", never a throw.
    expect(parseHashEntries(undefined, extract)).toEqual({});
  });

  it("keeps a `__proto__` hash field as an own property of the result", () => {
    const extract = (v: Record<string, unknown>): { points: number } | null =>
      typeof v.points === "number" ? { points: v.points } : null;
    const out = parseHashEntries(["__proto__", '{"points":10}', "team", '{"points":5}'], extract);
    // A plain `{}` object would take the first row's assignment as a
    // prototype write: the field is never own, `Object.keys` loses it, and
    // its value is inherited by every lookup made through the result.
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ points: 10 });
    expect(Object.keys(out)).toEqual(["__proto__", "team"]);
    expect(out.team).toEqual({ points: 5 });
  });

  it("parses a single HGET reply the same way as one hash row", () => {
    const extract = (v: Record<string, unknown>): number | null => (typeof v.points === "number" ? v.points : null);
    expect(parseJsonValue('{"points":7}', extract)).toBe(7);
    expect(parseJsonValue("null", extract)).toBeNull();
    expect(parseJsonValue("{", extract)).toBeNull();
    expect(parseJsonValue(undefined, extract)).toBeNull();
  });

  it("drops non-numeric counters rather than letting NaN into a total", () => {
    expect([...parseCounterHash(["a", "3", "b", "junk", "c", "NaN", "d", "4"])]).toEqual([
      ["a", 3],
      ["d", 4],
    ]);
    expect(parseCounterHash(null).size).toBe(0);
  });
});

describe("the attempt-row Lua read has one implementation", () => {
  for (const path of STORES) {
    const name = path.slice(path.lastIndexOf("/") + 1);

    it(`${name}'s grading script interpolates ATTEMPT_ROW_LUA`, () => {
      const src = read(path);
      // ai indents it one level (`ATTEMPT_ROW_LUA_INDENTED`) because it pastes
      // it inside a nested branch; the snippet itself is still the shared one.
      expect(src).toMatch(/\$\{ATTEMPT_ROW_LUA(_INDENTED)?\}/);
      // The regexes the shared snippet owns must not be re-spelled in a
      // store's own script body — that is the second copy.
      expect(src).not.toContain('"attempts":(%d+)');
      expect(src).not.toContain('"lastAtMs":(%d+)');
      expect(src).not.toContain('"firstAt":"([^"]*)"');
    });
  }

  it("reads the three fields the write side puts back", () => {
    // The three patterns, in the order each script reads them: attempts first
    // (the budget), then lastAtMs (the cooldown), then firstAt (carried
    // forward across rewrites).
    expect(ATTEMPT_ROW_LUA).toContain(`string.match(attemptsRaw, '"attempts":(%d+)[,}]')`);
    expect(ATTEMPT_ROW_LUA).toContain(`string.match(attemptsRaw, '"lastAtMs":(%d+)[,}]')`);
    expect(ATTEMPT_ROW_LUA).toContain(`string.match(attemptsRaw, '"firstAt":"([^"]*)"')`);
    // The row must be read as text, not cjson-decoded: a malformed row has to
    // read as "no attempts", not error the script and refuse a submission.
    expect(ATTEMPT_ROW_LUA).not.toContain("cjson");
    // It declares every local the surrounding guards use, so it can be pasted
    // into a script that then reads attempts/lastAtMs/firstAt directly.
    for (const local of ["attemptsRaw", "attempts", "lastAtMs", "firstAt"]) {
      expect(ATTEMPT_ROW_LUA).toContain(`local ${local}`);
    }
  });
});
