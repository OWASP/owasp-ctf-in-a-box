// The registry split (#504 M10).
//
// `REGISTRY` was a single ~1230-line object literal — 71% of lib/modules.ts —
// holding all four modules' copy. It is now one file per module under
// lib/module-defs/, assembled back into the same registry.
//
// What this pins:
//
//   - the split is BYTE-FAITHFUL. The moved text is contestant-facing copy,
//     and the one thing a split like this can silently do is reindent a line
//     that sits inside a template literal, which changes a string no test
//     reads verbatim. The copy markers below are the ones the module suites
//     assert against, so a mangled move fails here rather than shipping.
//   - registry ORDER. `ALL_MODULE_IDS` / `ALL_MODULE_ROUTES` / the nav all
//     derive from the object's key order, so sorting the assembled registry
//     would reorder the module picker.
//   - no runtime cycle. Each def takes `ModuleDef` back as a TYPE import and
//     its URLs from the dependency-free `module-urls.ts` leaf; a value import
//     from `@/lib/modules` would close modules.ts -> def -> modules.ts and
//     throw at init.
//   - the public surface is unchanged: `DOCS_URL`, `SCORING_BRANCH` and
//     `SECURE_AGENT_PLAYBOOK_URL` still come out of `@/lib/modules`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALL_MODULE_IDS,
  ALL_MODULE_ROUTES,
  DOCS_URL,
  SCORING_BRANCH,
  SECURE_AGENT_PLAYBOOK_URL,
  moduleDefById,
} from "@/lib/modules";
import * as urls from "@/lib/module-urls";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFS = join(LIB, "module-defs");
const read = (path: string): string => readFileSync(path, "utf8");

describe("one file per module", () => {
  it("exists for every registered module", () => {
    for (const id of ALL_MODULE_IDS) {
      expect(existsSync(join(DEFS, `${id}.ts`)), `module-defs/${id}.ts is missing`).toBe(true);
    }
    // Non-vacuous: the walk has to reach the four, not an empty directory.
    expect(ALL_MODULE_IDS).toHaveLength(4);
    expect(existsSync(join(LIB, "module-urls.ts"))).toBe(true);
  });

  it("lib/modules.ts no longer holds the copy itself", () => {
    const src = read(join(LIB, "modules.ts"));
    // Markers of the four entries' literal bodies.
    expect(src).not.toContain('displayName: "Secure Development"');
    expect(src).not.toContain('displayName: "Quiz"');
    expect(src).not.toContain('href: "/challenges", label: "Challenges"');
    expect(src).not.toContain("`You submit work as a pull request");
    // Non-vacuous: it is still the module module, just not the copy store.
    expect(src).toContain("export type ModuleId =");
    expect(src).toContain("export function moduleDefById(");
    expect(src).toContain("export function resolveModules(");
  });

  it.each([
    ["secure-development", 'id: "secure-development"', "Find the vulnerability, patch it for real, ship the fix as a PR."],
    ["quiz", 'id: "quiz"', "Answer security questions for points."],
    ["classic", 'id: "classic"', "Find the flag, submit the string, take the points."],
    ["ai", 'id: "ai"', "Prompt-injection and guardrail challenges hosted outside the box, scored inside it."],
  ])("%s keeps its own copy, byte for byte", (id, idLine, description) => {
    const src = read(join(DEFS, `${id}.ts`));
    expect(src).toContain(idLine);
    expect(src).toContain(description);
    expect(src).toContain("export const");
  });
});

describe("the assembled registry", () => {
  it("keeps registry order — the nav and the id list derive from it", () => {
    expect([...ALL_MODULE_IDS]).toEqual(["secure-development", "quiz", "classic", "ai"]);
    expect(ALL_MODULE_ROUTES).toEqual(["/challenges", "/quiz", "/flags", "/ai"]);
  });

  it("resolves every id to a def with a nav entry", () => {
    for (const id of ALL_MODULE_IDS) {
      const def = moduleDefById(id);
      expect(def?.id, `moduleDefById(${JSON.stringify(id)})`).toBe(id);
      expect(def?.nav?.href, `${id} nav`).toBeTruthy();
    }
    expect(moduleDefById("nope" as never)).toBeUndefined();
  });

  it("does not value-import the module back out of its own def", () => {
    for (const id of ALL_MODULE_IDS) {
      const src = read(join(DEFS, `${id}.ts`));
      // `import type { ModuleDef } from "@/lib/modules"` is erased at compile
      // time; anything else with the same specifier closes the loop.
      const valueImports = src
        .split("\n")
        .filter((l) => l.startsWith("import ") && !l.startsWith("import type ") && l.includes('from "@/lib/modules"'));
      expect(valueImports, `${id}.ts value-imports @/lib/modules`).toEqual([]);
      expect(src).toContain('import type { ModuleDef } from "@/lib/modules";');
    }
  });
});

describe("the public surface did not move", () => {
  it("still re-exports all three URLs from @/lib/modules", () => {
    expect(DOCS_URL).toBe(urls.DOCS_URL);
    expect(SCORING_BRANCH).toBe(urls.SCORING_BRANCH);
    expect(SECURE_AGENT_PLAYBOOK_URL).toBe(urls.SECURE_AGENT_PLAYBOOK_URL);
    expect(read(join(LIB, "modules.ts"))).toContain(
      'export { DOCS_URL, SCORING_BRANCH, SECURE_AGENT_PLAYBOOK_URL } from "@/lib/module-urls";',
    );
  });

  it("the leaf holds nothing but the three constants", () => {
    const src = read(join(LIB, "module-urls.ts"));
    expect(src).not.toMatch(/^import /m);
    expect(src).toMatch(/^export const DOCS_URL = /m);
    expect(src).toMatch(/^export const SCORING_BRANCH = /m);
    expect(src).toMatch(/^export const SECURE_AGENT_PLAYBOOK_URL = /m);
  });
});
