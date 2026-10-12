import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// CI runs the live-Redis suites by NAME: the app job's Lua step is
// `vitest run upstash`, a path filter, with CTF_LUA_SUITES_REQUIRED=1 so a
// suite that would skip fails instead. Both halves of that depend on naming.
// A suite that imports live-redis.ts but is not named `*.upstash.test.ts` is
// never selected by that step, and in the plain `pnpm test` run it has no
// Redis and skips — so it runs nowhere. A `*.upstash.test.ts` suite that does
// not gate through live-redis.ts escapes CTF_LUA_SUITES_REQUIRED and can skip
// green inside the step that exists to run it.

const srcRoot = join(import.meta.dirname, "..", "..");

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(p));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Only a RUNTIME import loads live-redis.ts and so arms its gate. TypeScript
// erases `import type { … }` and an import whose every specifier is
// `type X`, so a suite with only those would pass a textual check while never
// loading the gate.
function importsLiveRedis(source: string): boolean {
  if (/^\s*import\s+["'][^"']*\/live-redis["']/m.test(source)) return true;
  const re = /^\s*import\s+([^;]*?)\s+from\s+["'][^"']*\/live-redis["']/gm;
  for (const [, clause] of source.matchAll(re)) {
    if (/^type\s/.test(clause)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    if (!named) return true; // a default or namespace import is a runtime import
    const specifiers = named[1].split(",").map((x) => x.trim()).filter(Boolean);
    if (specifiers.some((x) => !/^type\s/.test(x))) return true;
  }
  return false;
}
const fileImportsLiveRedis = (file: string) => importsLiveRedis(readFileSync(file, "utf8"));
const files = testFiles(srcRoot);
const live = files.filter(fileImportsLiveRedis);

describe("importsLiveRedis counts only runtime imports", () => {
  it.each([
    ['import { liveConfigured } from "./live-redis";', true],
    ['import { RUN, liveConfigured } from "./live-redis";', true],
    ['import { type Foo, liveConfigured } from "./live-redis";', true],
    ['import "./live-redis";', true],
    ['import * as live from "./live-redis";', true],
    ['import type { Foo } from "./live-redis";', false],
    ['import { type Foo } from "./live-redis";', false],
    ['import { type Foo, type Bar } from "./live-redis";', false],
    ['export type { Foo } from "./live-redis";', false],
    ["// see live-redis.ts for the harness", false],
  ])("%s -> %s", (source, expected) => {
    expect(importsLiveRedis(source)).toBe(expected);
  });
});

describe("live-Redis suites are named so CI's `vitest run upstash` selects them", () => {
  it("finds the live suites at all", () => {
    // A floor, so a broken import regex cannot make the next two tests pass
    // on an empty list.
    expect(live.length).toBeGreaterThanOrEqual(14);
  });

  it("every suite importing live-redis.ts is named *.upstash.test.ts", () => {
    const misnamed = live.filter((f) => !f.endsWith(".upstash.test.ts")).map((f) => relative(srcRoot, f));
    expect(misnamed).toEqual([]);
  });

  it("every *.upstash.test.ts suite gates through live-redis.ts", () => {
    const ungated = files
      .filter((f) => f.endsWith(".upstash.test.ts") && !fileImportsLiveRedis(f))
      .map((f) => relative(srcRoot, f));
    expect(ungated).toEqual([]);
  });
});
