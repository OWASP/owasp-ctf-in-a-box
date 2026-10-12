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

const importsLiveRedis = (file: string) => /from\s+["'][^"']*\/live-redis["']/.test(readFileSync(file, "utf8"));
const files = testFiles(srcRoot);
const live = files.filter(importsLiveRedis);

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
      .filter((f) => f.endsWith(".upstash.test.ts") && !importsLiveRedis(f))
      .map((f) => relative(srcRoot, f));
    expect(ungated).toEqual([]);
  });
});
