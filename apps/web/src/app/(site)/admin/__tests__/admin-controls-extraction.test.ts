// Issue #504, finding M11: admin-controls.tsx was an 814-line driver that
// mixed the settings write path, the numeric drafts, the schedule stamp, the
// tab navigation and presentational bits like ChangedAt into one component.
// The fix extracted them into sibling hooks/components — and, like
// launch-guard-coverage.test.ts, this pins that structurally by READING the
// sources: the repo has no jsdom/testing-library (see admin-controls.test.tsx's
// header), and a source-level assertion is the only way to prove the code
// actually MOVED rather than was deleted or left duplicated. Every failure
// message below names what is missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN = join(__dirname, "..");
const read = (name: string) => readFileSync(join(ADMIN, name), "utf8");

describe("admin-controls extraction (#504, M11)", () => {
  it("composes the settings write hook from its sibling module instead of declaring the state itself", () => {
    const src = read("admin-controls.tsx");
    expect(
      src,
      'admin-controls.tsx does not call useAdminSettingsDrafts( — the settings/draft/write state was not extracted into use-admin-settings.ts',
    ).toContain("useAdminSettingsDrafts(");
    expect(
      src,
      'admin-controls.tsx has no import from "./use-admin-settings" — the write path (pending/error/confirm, syncInputs, apply/applyField/commitNumber) still lives inline',
    ).toContain('from "./use-admin-settings"');
    // The nine numeric drafts are the clearest single symptom of the old
    // inline state machine; the shell must not redeclare any of them.
    expect(
      src,
      "admin-controls.tsx still declares the numeric draft state directly (useState for a *Input) — the drafts did not move out",
    ).not.toMatch(/useState\(\s*initial\./);
  });

  it("imports ChangedAt, with its <time> markup, from a sibling file", () => {
    expect(
      existsSync(join(ADMIN, "admin-changed-at.tsx")),
      "admin-changed-at.tsx is missing — ChangedAt has no sibling file to have moved to",
    ).toBe(true);
    expect(
      read("admin-changed-at.tsx"),
      'admin-changed-at.tsx does not contain the <time dateTime={iso} title={iso}> markup — ChangedAt did not actually move there',
    ).toContain("<time dateTime={iso} title={iso}>");
    const src = read("admin-controls.tsx");
    expect(
      src,
      'admin-controls.tsx has no import from "./admin-changed-at" — the audit-line clock is either still inline or deleted, not extracted',
    ).toContain('from "./admin-changed-at"');
    expect(
      src,
      "admin-controls.tsx still renders the <time dateTime={iso}> markup itself — the component was duplicated, not moved",
    ).not.toContain("<time dateTime={iso}");
  });

  it("still re-exports nextEventNameAfterSave for the import sites that pin it", () => {
    expect(
      read("admin-controls.tsx"),
      "admin-controls.tsx no longer re-exports nextEventNameAfterSave from ./use-admin-settings — admin-controls.test.tsx imports it from @/app/(site)/admin/admin-controls and would break",
    ).toMatch(/export\s*\{[^}]*\bnextEventNameAfterSave\b[^}]*\}\s*from\s*["']\.\/use-admin-settings["']/);
  });

  it("keeps the shell under the size budget", () => {
    const lines = read("admin-controls.tsx").replace(/\n$/, "").split("\n").length;
    expect(
      lines,
      `admin-controls.tsx is ${lines} lines — the extraction left too much in the driver (budget: 600, was 814 before the fix)`,
    ).toBeLessThan(600);
  });
});
