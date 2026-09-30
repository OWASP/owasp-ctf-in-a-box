import { describe, expect, it } from "vitest";
import { mockEnabledModules } from "@/test/enabled-modules-mock";

// The real `defaultModuleIds` is the deployment's own default set, and
// admin-controls reads it when no module toggles are stored. The stand-in must
// agree with the suite's live set, or a quiz-only fixture would render every
// module as live (#516 review).
describe("mockEnabledModules", () => {
  it("defaultModuleIds is the suite's live set, not every known module", async () => {
    const m = mockEnabledModules(["quiz"]);
    expect(m.defaultModuleIds).toEqual(["quiz"]);
    expect([...(await m.getEnabledModuleIds())]).toEqual(["quiz"]);
    expect(mockEnabledModules([]).defaultModuleIds).toEqual([]);
  });

  it("follows a predicate a test flips, read at the moment of use", () => {
    let aiLive = false;
    const m = mockEnabledModules((id) => id === "secure-development" || (id === "ai" && aiLive));
    expect(m.defaultModuleIds).toEqual(["secure-development"]);
    aiLive = true;
    expect(m.defaultModuleIds).toEqual(["secure-development", "ai"]);
  });
});
