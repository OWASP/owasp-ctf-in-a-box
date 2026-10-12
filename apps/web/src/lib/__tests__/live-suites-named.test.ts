import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
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

// Only a RUNTIME import loads live-redis.ts and so arms its gate. The source
// is parsed with the TypeScript compiler rather than matched as text, so a
// commented-out import, one inside a string, and the forms TypeScript erases
// (`import type`, a specifier list that is all `type X`, `export type … from`)
// do not count, while a dynamic `import("./live-redis")` and a re-export do.
const isLiveRedis = (spec: ts.Expression | undefined) =>
  spec !== undefined && ts.isStringLiteral(spec) && /(^|\/)live-redis(\.[cm]?[jt]s)?$/.test(spec.text);

function importsLiveRedis(source: string): boolean {
  const file = ts.createSourceFile("suite.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node) && isLiveRedis(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) found = true; // a side-effect import
      else if (!clause.isTypeOnly) {
        const named = clause.namedBindings;
        found =
          clause.name !== undefined ||
          (named !== undefined && (ts.isNamespaceImport(named) || named.elements.some((e) => !e.isTypeOnly)));
      }
    } else if (ts.isExportDeclaration(node) && isLiveRedis(node.moduleSpecifier) && !node.isTypeOnly) {
      const clause = node.exportClause;
      found = clause === undefined || !ts.isNamedExports(clause) || clause.elements.some((e) => !e.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isLiveRedis(node.arguments[0])
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
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
    ['const live = await import("./live-redis");', true],
    ['import("@/lib/__tests__/live-redis").then(() => {});', true],
    ['import live from "./live-redis";', true],
    ['export { liveKey } from "./live-redis";', true],
    ['/* import { liveConfigured } from "./live-redis"; */', false],
    ['// import { liveConfigured } from "./live-redis";', false],
    ['/*\n import { liveConfigured } from "./live-redis";\n*/', false],
    ['const s = \'import { liveConfigured } from "./live-redis";\';', false],
    ['import { liveConfigured } from "./not-live-redis";', false],
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
