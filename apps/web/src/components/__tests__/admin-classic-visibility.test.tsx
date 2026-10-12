// The admin half of a Jeopardy challenge's visibility: the form's "Visible to
// contestants" switch, the status chip on each row, and the payloads and
// export carrying the field — a reorder or an export must never quietly
// publish a hidden challenge.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBundle } from "@/lib/classic-io";
import type { AdminChallenge, Challenge } from "@/lib/classic-store";
import AdminClassicControls, {
  ChallengeForm,
  draftFromChallenge,
  editorFromChallenge,
  emptyDraft,
  exportBundleFrom,
  payloadFromEditor,
  payloadFromRow,
} from "@/components/admin-classic-controls";

const noop = () => {};
const live: Challenge = { id: "live-ab12cd", title: "Live one", category: "Web", description: "", points: 10, order: 1 };
const off: Challenge = { id: "off-ab12cd", title: "Off one", category: "Web", description: "", points: 20, order: 2, enabled: false };
const row = (c: Challenge): AdminChallenge => ({ challenge: c, flag: "CTF{x}", hint: null });

describe("the draft and its payloads", () => {
  it("starts a new challenge visible, as before the switch existed", () => {
    expect(emptyDraft("Web").enabled).toBe(true);
  });

  it("seeds the switch from the stored record", () => {
    expect(draftFromChallenge(row(live)).enabled).toBe(true);
    expect(draftFromChallenge(row(off)).enabled).toBe(false);
  });

  it("sends enabled:false only when switched off, so a live record stays byte-identical", () => {
    const editor = editorFromChallenge(row(live));
    expect("enabled" in payloadFromEditor(editor)).toBe(false);
    expect(payloadFromEditor({ ...editor, draft: { ...editor.draft, enabled: false } }).enabled).toBe(false);
  });

  it("carries enabled:false through a reorder, which must never publish a hidden challenge", () => {
    expect(payloadFromRow(row(off)).enabled).toBe(false);
    expect("enabled" in payloadFromRow(row(live))).toBe(false);
  });

  it("exports the field, stamps version 4, and the file parses", () => {
    const bundle = exportBundleFrom([row(live), row(off)], ["Web"]);
    expect(bundle.version).toBe(4);
    expect(bundle.challenges[1].enabled).toBe(false);
    expect("enabled" in bundle.challenges[0]).toBe(false);
    expect(parseBundle(JSON.stringify(bundle)).ok).toBe(true);
    expect(exportBundleFrom([row(live)], ["Web"]).version).toBe(2);
  });
});

describe("the form", () => {
  function renderForm(c: Challenge) {
    return renderToStaticMarkup(
      <ChallengeForm
        editor={editorFromChallenge(row(c))}
        categories={["Web"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
  }

  it("offers a Visible to contestants switch, on for a live challenge and off for a disabled one", () => {
    const on = renderForm(live);
    expect(on).toContain("Visible to contestants");
    expect(on).toMatch(/<input type="checkbox" aria-describedby="visible-help"[^>]*checked=""/);
    const offHtml = renderForm(off);
    expect(offHtml).toContain("Visible to contestants");
    expect(offHtml).not.toMatch(/<input type="checkbox" aria-describedby="visible-help"[^>]*checked=""/);
  });
});

describe("the status chip", () => {
  it("names each row Live or Disabled", () => {
    const html = renderToStaticMarkup(
      <AdminClassicControls
        initialLoaded
        pending={false}
        classicCooldownSecInput="5"
        setClassicCooldownSecInput={noop}
        commitNumber={noop}
        initialChallenges={[row(live), row(off)]}
        initialCategories={["Web"]}
      />,
    );
    expect(html).toMatch(/data-status="live"[^>]*>Live</);
    expect(html).toMatch(/data-status="disabled"[^>]*>Disabled</);
  });
});
