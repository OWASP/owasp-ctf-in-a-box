import { describe, expect, it } from "vitest";

import { ALL_MODULE_ROUTES, resolveModules, moduleDefById, type ModuleId } from "@/lib/modules";
import type { OrgContext, RulesContext } from "@/lib/modules";

// The live set is now the sole source of enablement (issue #386): there is no
// more baked list to derive it from, so tests that need "both modules on"
// pass this explicitly.
const ENABLED = new Set<ModuleId>(["secure-development", "quiz"]);

describe("module registry", () => {
  it("resolves the live set in registry order", () => {
    expect(resolveModules({}, ENABLED).map((m) => m.id)).toEqual(["secure-development", "quiz"]);
  });

  it("gives secure-development its display metadata and nav entry", () => {
    const mod = moduleDefById("secure-development")!;
    expect(mod.displayName).toBe("Secure Development");
    expect(mod.nav).toEqual({ href: "/challenges", label: "Challenges" });
  });

  it("gives quiz its own nav entry now that /quiz exists", () => {
    expect(moduleDefById("quiz")!.nav).toEqual({ href: "/quiz", label: "Quiz" });
  });

  it("registers classic with its own route, distinct from secure-development's", () => {
    expect(ALL_MODULE_ROUTES).toContain("/flags");
    expect(ALL_MODULE_ROUTES).toContain("/challenges");
  });
});

describe("module registry — negative enablement", () => {
  it("resolves an empty live set to no modules", () => {
    expect(resolveModules({}, new Set())).toEqual([]);
  });

  it("resolves a live set of just quiz to exactly the quiz def", () => {
    const resolved = resolveModules({}, new Set(["quiz"]));
    expect(resolved.map((m) => m.id)).toEqual(["quiz"]);
  });
});

// Issue #249: secure-development's contestant copy said that revealing a hint
// costs points; classic's did not, though both sell hints
// through the same gate. On a classic-only event a contestant learned
// the price only from the reveal button itself.
describe("hint cost is stated wherever hints are sold", () => {
  // Driven by `HintTarget` (hint-store.ts) rather than a list written out
  // here: the modules that sell hints are secure-development (via its
  // targets) and classic. A third one added to that union without this
  // copy should fail here rather than ship silently.
  const SELL_HINTS = ["secure-development", "classic"] as const;

  // Real contexts, not a cast. `rules` takes a `RulesContext` and `terms` an
  // `OrgContext` (the same plus `githubOrg`) — an `as never` fixture with the
  // wrong field names type-checks and then runs every builder with
  // `ctx.appList` undefined, which is exactly the sort of hidden hole these
  // copy tests exist to catch.
  const RULES_CTX: RulesContext = { appCount: 1, appList: "DVWA" };
  const ORG_CTX: OrgContext = { ...RULES_CTX, githubOrg: "example-org" };

  it.each(SELL_HINTS)("%s tells contestants that a hint deducts points, in both rules and terms", (id) => {
    const mod = moduleDefById(id)!;
    // `scoring` is optional on the copy types, so its presence is part of
    // what is being asserted: a module that sells hints and ships no scoring
    // copy at all fails here rather than passing on an empty string.
    const rulesScoring = mod.rules!(RULES_CTX).scoring;
    const termsScoring = mod.terms!(ORG_CTX).scoring;
    expect(rulesScoring).toBeDefined();
    expect(termsScoring).toBeDefined();
    const rules = rulesScoring!.join(" ");
    const terms = termsScoring!.join(" ");
    expect(rules).toMatch(/hint/i);
    expect(rules).toMatch(/deduct/i);
    expect(terms).toMatch(/hint/i);
    expect(terms).toMatch(/deduct/i);
  });

  it("says nothing of the sort for quiz, which sells no hints", () => {
    // Not an oversight to fix later: quiz has no hints by design, so the
    // sentence would be a lie there.
    const mod = moduleDefById("quiz")!;
    expect((mod.rules!(RULES_CTX).scoring ?? []).join(" ")).not.toMatch(/hint/i);
    expect((mod.terms!(ORG_CTX).scoring ?? []).join(" ")).not.toMatch(/hint/i);
  });
});
