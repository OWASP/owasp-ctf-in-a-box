// The demo-seed extraction (#504 M9).
//
// Demo seeding and clearing was 43% of admin-store.ts — a fixture writer, two
// EVAL scripts and ~750 lines of row building, none of it sharing state with
// the settings, admins and audit code the rest of that file is about. What
// makes it not a "move code between files and hope" refactor are the two
// couplings it kept, and both are pinned here rather than left to be
// rediscovered:
//
//   1. The settings read stays in admin-store.ts. `seedDemoData` has always
//      read the snapshot and failed closed on a blip, and demo-seed is
//      imported BY admin-store (for the wrapper and the `clearDemoData`
//      re-export), so importing `getAdminSettings` back would be a cycle —
//      the one `module-defaults.ts` exists to avoid. The snapshot goes over
//      as an argument instead.
//   2. The audit trail is still ONE trail. The seed appends to the same
//      `ctf:admin:audit` list every admin write does; the key and cap moved
//      to a dependency-free leaf so demo-seed could reach them without the
//      store, and admin-store re-exports them so its callers keep one import.
//
// The behaviour itself is covered by admin-store.seed.test.ts,
// admin-store.clear-demo.test.ts and admin-store.seed-categories.upstash.test.ts,
// which still import both entry points from `@/lib/admin-store`. These
// assertions are about the SOURCE — read from disk rather than imported,
// because the claim is which file spells the code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(join(LIB, file), "utf8");

describe("the demo seed body moved to lib/demo-seed.ts", () => {
  it("exists beside the store that hands it the settings snapshot", () => {
    // A moved or renamed file reads as ENOENT rather than leaving the
    // negative assertions below to pass against nothing.
    expect(existsSync(join(LIB, "demo-seed.ts"))).toBe(true);
  });

  it("admin-store.ts no longer carries the fixture writer", () => {
    const src = read("admin-store.ts");
    expect(src).not.toContain("RAISE_SOLVECOUNT_SCRIPT");
    expect(src).not.toContain("function demoAttemptRow");
    expect(src).not.toContain("export const SEED_CATEGORIES_SCRIPT");
    expect(src).not.toContain("seedDemoAttachments");
    // …and it no longer reaches for the fixture at all: the whole reason the
    // extraction changes the shape of this file.
    expect(src).not.toContain('from "@/lib/demo-fixture"');
    // Non-vacuous: the store still holds its own danger surface, so the
    // checks above are not passing because admin-store.ts is empty.
    expect(src).toContain("export async function resetEvent(");
    expect(src).toContain("export async function getAdminSettings(");
  });

  it("demo-seed.ts carries them instead", () => {
    const src = read("demo-seed.ts");
    expect(src).toContain("const RAISE_SOLVECOUNT_SCRIPT =");
    expect(src).toContain("function demoAttemptRow");
    expect(src).toContain("export const SEED_CATEGORIES_SCRIPT");
    expect(src).toContain("async function seedDemoAttachments");
    expect(src).toContain("export async function runDemoSeed(");
    expect(src).toContain("export async function clearDemoData(");
    expect(src).toContain('from "@/lib/demo-fixture"');
  });
});

describe("the two couplings the move had to keep", () => {
  it("admin-store.ts owns the settings read and hands the snapshot over", () => {
    const src = read("admin-store.ts");
    expect(src).toContain("return runDemoSeed(await getAdminSettings(), actor);");
    // The interface every existing caller uses is unchanged: all three still
    // come out of `@/lib/admin-store`.
    expect(src).toContain('export { SEED_CATEGORIES_SCRIPT, clearDemoData } from "@/lib/demo-seed";');
    expect(src).toContain("export async function seedDemoData(");
  });

  it("demo-seed.ts reads no value back out of admin-store — no cycle", () => {
    const src = read("demo-seed.ts");
    // The one import from the store is a TYPE, which erases at compile time;
    // any other would close the loop admin-store -> demo-seed -> admin-store.
    expect(src).toContain('import type { AdminSettings } from "@/lib/admin-store";');
    const valueImports = src
      .split("\n")
      .filter((l) => l.startsWith("import ") && !l.startsWith("import type ") && l.includes("@/lib/admin-store"));
    expect(valueImports).toEqual([]);
    expect(src).not.toContain("getAdminSettings(");
  });

  it("the audit trail's key comes from one dependency-free leaf", () => {
    expect(existsSync(join(LIB, "admin-audit-keys.ts"))).toBe(true);
    const leaf = read("admin-audit-keys.ts");
    expect(leaf).toContain('export const ADMIN_AUDIT_KEY = "ctf:admin:audit";');
    expect(leaf).toContain("export const AUDIT_CAP = 500;");
    // Nothing heavier than the two constants in the leaf — no imports at all
    // — which is what makes it importable from both sides without a cycle.
    expect(leaf).not.toMatch(/^import /m);
    expect(leaf).not.toContain("upstashPipeline");
    for (const file of ["admin-store.ts", "demo-seed.ts"]) {
      expect(read(file)).toContain('from "@/lib/admin-audit-keys"');
    }
    // admin-store keeps re-exporting them, so admin/* routes and
    // admin-ops-store.ts import as they always did.
    expect(read("admin-store.ts")).toContain("export { ADMIN_AUDIT_KEY, AUDIT_CAP };");
  });
});
