// The ai module's registration in the registry — enablement is a runtime
// /admin setting, not a registration concern (config v2, issue #386).
import { describe, expect, it } from "vitest";

import { moduleDefById, resolveModules } from "@/lib/modules";

describe("ai module registration", () => {
  it("resolves onto the live set and carries its display metadata", () => {
    const [mod] = resolveModules({}, new Set(["ai"]));
    expect(mod.id).toBe("ai");
    const def = moduleDefById("ai")!;
    expect(def.displayName).toBe("AI");
    expect(def.description).toBeTruthy();
  });

  it("gives ai its own nav entry now that /ai exists", () => {
    expect(moduleDefById("ai")!.nav).toEqual({ href: "/ai", label: "AI" });
  });
});
