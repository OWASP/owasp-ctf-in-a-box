// The bulk import/export panel the quiz and classic admin panels share. The
// two panels' JSX differed in three sentences (all props here); the hook
// behind it differed in the endpoint, the parser and the summary shape. This
// repo's tests render with `renderToStaticMarkup` and cannot paste or click,
// so the panel is proven statically and the client-side gate that enables the
// Import button through the exported pure `clientValidation`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ImportPanel from "@/components/admin/import-panel";
import { type BundleParse, FILE_READ_ERROR, IMPORT_TEXTAREA_MAX, clientValidation } from "@/components/admin/use-bundle-import";

const noop = () => {};

const parse = (raw: string): BundleParse =>
  raw.trim() === "ok" ? { ok: true } : { ok: false, errors: [{ where: "$", message: "must be an object" }] };

describe("clientValidation", () => {
  it("skips an empty textarea entirely — no errors, and nothing to import", () => {
    expect(clientValidation("   ", parse)).toEqual({ errors: null, canImport: false });
  });

  it("surfaces the parser's errors and keeps the button disabled", () => {
    expect(clientValidation("{}", parse)).toEqual({ errors: [{ where: "$", message: "must be an object" }], canImport: false });
  });

  it("enables the button for text the parser accepts", () => {
    expect(clientValidation("ok", parse)).toEqual({ errors: null, canImport: true });
  });
});

describe("ImportPanel", () => {
  function render(overrides: Partial<Parameters<typeof ImportPanel>[0]> = {}) {
    return renderToStaticMarkup(
      <ImportPanel
        exportDescription="Downloads every question currently in the bank as one JSON file, correct answers included."
        exportLabel="Export questions"
        exportDisabled={false}
        onExport={noop}
        notice={<>Import never deletes existing questions.</>}
        text=""
        pending={false}
        clientErrors={null}
        importErrors={null}
        summary={null}
        canImport={false}
        onText={noop}
        onFile={noop}
        onSubmit={noop}
        {...overrides}
      />,
    );
  }

  it("is a collapsible <details> whose content is present even while closed", () => {
    const html = render();
    expect(html).toMatch(/^<details/);
    expect(html).not.toContain("<details open");
    expect(html).toContain("<summary");
    expect(html).toMatch(/bulk import \/ export/i);
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".json"');
    expect(html).toContain("Paste a bundle&#x27;s JSON here, or choose a file below.");
  });

  it("renders the module's copy: export description and label, and the never-deletes notice", () => {
    const html = render();
    expect(html).toContain("Downloads every question currently in the bank as one JSON file, correct answers included.");
    expect(html).toMatch(/<button[^>]*>Export questions</);
    expect(html).toContain("Import a bundle");
    expect(html).toContain("Import never deletes existing questions.");
  });

  it("disables Export when there is nothing to export", () => {
    expect(render({ exportDisabled: true })).toMatch(/<button[^>]*disabled=""[^>]*>Export questions</);
    expect(render()).not.toMatch(/<button[^>]*disabled=""[^>]*>Export questions</);
  });

  it("gates the Import button on canImport and shows the in-flight label", () => {
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Import bundle</);
    expect(render({ canImport: true })).not.toMatch(/<button[^>]*disabled=""[^>]*>Import bundle</);
    expect(render({ canImport: true, pending: true })).toMatch(/<button[^>]*disabled=""[^>]*>Importing…</);
  });

  it("lists client and import errors as where: message, and the summary line", () => {
    const html = render({
      clientErrors: [{ where: "questions[0].id", message: "must match" }],
      importErrors: [{ where: "(request)", message: "Store unavailable — try again shortly." }],
      summary: "Imported 1 question: 1 created, 0 updated.",
    });
    expect(html).toContain("<li>questions[0].id: must match</li>");
    expect(html).toContain("<li>(request): Store unavailable — try again shortly.</li>");
    expect(html).toContain('<p class="text-sm text-white">Imported 1 question: 1 created, 0 updated.</p>');
  });

  it("shows a file the browser could not read, which reaches no server at all", () => {
    // #284: `handleFile` awaited `file.text()` with no catch and both panels
    // `void` that promise, so a rejected read changed nothing on screen. The
    // panel needs somewhere to put it, and this is that slot.
    const html = render({ importErrors: [FILE_READ_ERROR] });
    expect(html).toContain("<li>(file): Couldn’t read that file — try choosing it again.</li>");
  });

  it("offers no Include files option unless the module passes one", () => {
    expect(render()).not.toContain("Include files");
  });

  it("renders an unticked Include files checkbox next to Export, ticked when asked", () => {
    const off = render({ includeFiles: false, onIncludeFiles: noop });
    expect(off).toMatch(/<input[^>]*type="checkbox"[^>]*>[^<]*Include files/);
    expect(off).not.toMatch(/<input[^>]*checked=""[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(render({ includeFiles: true, onIncludeFiles: noop })).toMatch(/<input[^>]*checked=""[^>]*>|<input[^>]*type="checkbox"[^>]*checked=""/);
  });

  it("shows an export error and the in-flight export label", () => {
    const html = render({ exportError: "Couldn't read the files — try again.", exportPending: true });
    expect(html).toContain("Couldn&#x27;t read the files — try again.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Exporting…</);
  });

  // A bundle with files is tens of MB: a controlled textarea of it freezes
  // the tab, so it is held, validated and sent as-is, and described instead.
  it("holds a bundle too large to edit out of the textarea, with a Clear button", () => {
    const html = render({ text: "x".repeat(IMPORT_TEXTAREA_MAX + 1) });
    expect(html).not.toContain("<textarea");
    expect(html).toMatch(/too large to show here/);
    expect(html).toMatch(/<button[^>]*>Clear</);
    expect(render({ text: "{}" })).toContain("<textarea");
  });
});
