// The panel's module names (audit F25).
//
// `vocabulary.ts` duplicates the registry's display names because the two
// screens that need them are handed no resolved module list. A duplicate is
// only acceptable while something proves it is still a copy — which is this
// file's entire job.
import { describe, expect, it } from "vitest";
import { MODULE_LABEL, moduleLabel } from "../vocabulary";
import { ALL_MODULE_IDS, moduleDefById } from "@/lib/modules";
import { TYPE_LABELS } from "../admin-activity-tab";

describe("MODULE_LABEL", () => {
  it("matches the registry's displayName for every module", () => {
    for (const id of ALL_MODULE_IDS) {
      expect(MODULE_LABEL[id]).toBe(moduleDefById(id)?.displayName);
    }
  });

  it("covers every module the registry knows, with nothing extra", () => {
    expect(Object.keys(MODULE_LABEL).sort()).toEqual([...ALL_MODULE_IDS].sort());
  });
});

describe("moduleLabel", () => {
  it("names a known module", () => {
    expect(moduleLabel("classic")).toBe("Jeopardy");
    expect(moduleLabel("secure-development")).toBe("Secure Development");
  });

  it("falls back to the id for one this build does not know", () => {
    // A row written by a newer build must still render — the same rule the
    // activity log applies to unknown event types.
    expect(moduleLabel("some-future-module")).toBe("some-future-module");
  });
});

describe("the activity log speaks the same vocabulary", () => {
  it("names each solve after its module's tab", () => {
    // Before: "flag solve" under a tab called Jeopardy, and "ai solve" —
    // the raw registry id — under one called AI.
    expect(TYPE_LABELS["classic-solve"]).toBe("Jeopardy solve");
    expect(TYPE_LABELS["ai-solve"]).toBe("AI solve");
    expect(TYPE_LABELS["quiz-solve"]).toBe("Quiz solve");
  });

  it("leaves the stored type strings alone", () => {
    // Only the label changed. The keys are what the store writes and what the
    // filter chips match on; renaming one would silently hide rows.
    for (const type of ["quiz-solve", "classic-solve", "ai-solve", "login"]) {
      expect(TYPE_LABELS).toHaveProperty(type);
    }
  });
});
