// Source-reading test for the dedup that issue #504 M14 asked for: the
// Challenges panel frame (settings-card slot, category editor, panel div with
// heading + Add + list-error line, grouped SortableList, and the form plus
// discard-draft/delete confirmations under it) is rendered in ONE place —
// components/admin/challenge-frame.tsx — and admin-classic-controls.tsx /
// admin-ai-controls.tsx only hand it their module-specific pieces.
//
// Rendering cannot prove the duplication is gone (the existing suites already
// pin the rendered markup, byte for byte, in admin-classic-controls.test.tsx
// and admin-ai-controls.test.tsx), so this test reads the three sources and
// asserts the frame owns the shared literals exactly once while each panel
// keeps only what is genuinely its own — plus the export surface both suites
// and admin-controls.tsx import. Like hint-reveal-button.test.ts, the
// decisive check in each `it` is its last statement.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const classicPath = fileURLToPath(new URL("../admin-classic-controls.tsx", import.meta.url));
const aiPath = fileURLToPath(new URL("../admin-ai-controls.tsx", import.meta.url));
const framePath = fileURLToPath(new URL("../admin/challenge-frame.tsx", import.meta.url));

const classic = readFileSync(classicPath, "utf8");
const ai = readFileSync(aiPath, "utf8");
// Throws ENOENT naming the path when the shared frame is missing — which is
// exactly the regression: a panel that grew its own copy of the frame again.
const frame = readFileSync(framePath, "utf8");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const panels: Array<[string, string]> = [
  ["admin-classic-controls.tsx", classic],
  ["admin-ai-controls.tsx", ai],
];

/** Literals the frame now owns. Each must appear zero times across the two
 *  panels and exactly once in the frame — the "one copy, not three" rule. */
const sharedLiterals: Array<[string, string]> = [
  ["the category-editor rename wiring", "onCommitRename={categoryEditor.commitRename}"],
  [
    "the Add-challenge toolbar button",
    'className="rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"',
  ],
  ["the Challenges panel wrapper", '<div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">'],
  ["the panel heading", '<span className="text-white">Challenges</span>'],
  ["the list-error Retry button", "text-white hover:underline"],
];

describe("admin module controls share one Challenges-panel frame", () => {
  it("renders the shared frame from one module both panels import", () => {
    for (const [name, source] of panels) {
      expect(
        occurrences(source, 'from "@/components/admin/challenge-frame"'),
        `${name} must import the shared frame from "@/components/admin/challenge-frame"`,
      ).toBe(1);
    }
    expect(frame, "the shared frame module must render the settings card").toContain("<AdminSettingsCard");
    expect(frame, "the shared frame module must render the category editor").toContain("<CategoryEditor");
    expect(frame, "the shared frame module must render the grouped list").toContain("<SortableList");
    expect(frame, "the shared frame module must render the discard-draft confirm").toContain("<DiscardDraftConfirm");
    expect(frame, "the shared frame module must render the delete confirm").toContain("<ConfirmDelete");
    expect(occurrences(frame, "<SortableList"), "the frame owns exactly one SortableList").toBe(1);
  });

  it("keeps the shared literals in the frame only — not in either panel", () => {
    for (const [what, literal] of sharedLiterals) {
      for (const [name, source] of panels) {
        expect(occurrences(source, literal), `${name} must not keep its own copy of ${what}`).toBe(0);
      }
      expect(occurrences(frame, literal), `the shared frame must hold the one copy of ${what}`).toBe(1);
    }
  });

  it("keeps each panel's module-specific pieces (imports, exports, hooks)", () => {
    // The pieces only that module has must still be in its panel, not hoisted.
    expect(occurrences(classic, "<AdminClassicStories"), "classic keeps its stories panel").toBe(1);
    expect(occurrences(classic, "<ImportPanel"), "classic keeps its bulk import/export panel").toBe(1);
    expect(occurrences(ai, "rotateError"), "ai keeps its rotate-error notice").toBeGreaterThan(0);
    expect(occurrences(ai, "<AdminAiIntegration"), "ai keeps its per-row integration panel").toBe(1);

    // The export surface the existing suites and admin-controls.tsx import.
    // Decisive: every one of these must still be present, named.
    for (const [name, source, form] of [
      ["admin-classic-controls.tsx", classic, "ChallengeForm"],
      ["admin-ai-controls.tsx", ai, "AiChallengeForm"],
    ] as const) {
      expect(occurrences(source, "export default function"), `${name} must keep its default export`).toBe(1);
      expect(
        occurrences(source, `export { ${form} } from`),
        `${name} must keep re-exporting its form component`,
      ).toBe(1);
    }
    expect(
      occurrences(ai, 'export * from "@/components/admin-ai-model"'),
      'admin-ai-controls.tsx must keep export * from "@/components/admin-ai-model"',
    ).toBe(1);
    expect(
      occurrences(classic, 'export * from "@/components/admin-classic-model"'),
      'admin-classic-controls.tsx must keep export * from "@/components/admin-classic-model"',
    ).toBe(1);
  });
});
