// The add/edit dialog that replaced the always-open form above the list.
// What is worth pinning is the behaviour the old form got wrong:
//
//   - editing shows the logo ALREADY on file (the old form showed nothing, so
//     replacing a logo meant uploading one to find out what the old one was),
//   - "Remove logo" is offered only where there is a logo to remove,
//   - the draft it submits carries the fields the upsert route accepts, and
//     never an `order` — position is the list's arrows, not this form's.
//
// No DOM here (the repo has no @testing-library/react — see
// focus-management.test.ts for the standing decision), so state-dependent
// behaviour is exercised by calling the real handlers off the element tree.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import SponsorEditorDialog, { type SponsorDraft } from "../sponsor-editor-dialog";
import type { SponsorRecord } from "../sponsor-list";

type ReactEl = { type: unknown; props?: Record<string, unknown> };

function findAll(node: unknown, predicate: (el: ReactEl) => boolean, out: ReactEl[] = []): ReactEl[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (!("type" in node)) return out;
  const el = node as ReactEl;
  if (predicate(el)) out.push(el);
  findAll(el.props?.children, predicate, out);
  return out;
}

function captureTree<P>(Component: (props: P) => ReactElement | null, props: P): ReactElement {
  let captured: ReactElement | null = null;
  function Probe() {
    captured = Component(props);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error("Probe never captured the component's returned element");
  return captured;
}

const WITH_LOGO: SponsorRecord = {
  id: "zzyzx-sec-ab12cd",
  name: "Zzyzx Security Labs",
  url: "https://zzyzx.example",
  blurb: "A fixture sponsor.",
  tier: "gold",
  order: 2,
  logo: { type: "image/png", w: 120, h: 40 },
};
const WITHOUT_LOGO: SponsorRecord = { ...WITH_LOGO, id: "acme-ef34gh", name: "Acme Co", logo: null };

const noop = () => {};

function render(sponsor: SponsorRecord | null, over: Partial<Parameters<typeof SponsorEditorDialog>[0]> = {}) {
  return renderToStaticMarkup(
    <SponsorEditorDialog sponsor={sponsor} pending={false} error={null} onSubmit={noop} onCancel={noop} {...over} />,
  );
}

describe("SponsorEditorDialog", () => {
  it("opens on the record being edited, with its values in the fields", () => {
    const html = render(WITH_LOGO);
    expect(html).toContain(`Edit ${WITH_LOGO.name}`);
    expect(html).toContain(WITH_LOGO.url);
    expect(html).toContain(WITH_LOGO.blurb);
  });

  it("shows the logo already on file when editing", () => {
    expect(render(WITH_LOGO)).toContain(`/api/sponsors/logo/${WITH_LOGO.id}`);
    expect(render(WITH_LOGO)).toContain("Replace logo…");
  });

  it("offers Remove logo only for a sponsor that has one", () => {
    expect(render(WITH_LOGO)).toContain("Remove logo on save");
    expect(render(WITHOUT_LOGO)).not.toContain("Remove logo on save");
    expect(render(null)).not.toContain("Remove logo on save");
  });

  it("is an Add dialog with an empty draft when given no record", () => {
    const html = render(null);
    expect(html).toContain("Add sponsor");
    expect(html).toContain("Choose logo…");
    expect(html).not.toContain(WITH_LOGO.name);
  });

  it("keeps Save disabled until name and URL are both filled in", () => {
    const disabledOf = (sponsor: SponsorRecord | null) => {
      const tree = captureTree(SponsorEditorDialog, {
        sponsor,
        pending: false,
        error: null,
        onSubmit: noop,
        onCancel: noop,
      } as Parameters<typeof SponsorEditorDialog>[0]);
      return findAll(tree, (el) => el.type === "button" && el.props?.type === "submit")[0]!.props?.disabled;
    };
    expect(disabledOf(null)).toBe(true);
    expect(disabledOf(WITH_LOGO)).toBe(false);
    // A record whose name is whitespace is as unsavable as an empty one.
    expect(disabledOf({ ...WITH_LOGO, name: "   " })).toBe(true);
  });

  it("submits the record's fields and no order — position is the list's arrows", () => {
    const onSubmit = vi.fn<(draft: SponsorDraft) => void>();
    const tree = captureTree(SponsorEditorDialog, {
      sponsor: WITH_LOGO,
      pending: false,
      error: null,
      onSubmit,
      onCancel: noop,
    } as Parameters<typeof SponsorEditorDialog>[0]);
    const form = findAll(tree, (el) => el.type === "form")[0]!;
    (form.props as { onSubmit: (e: { preventDefault: () => void }) => void }).onSubmit({ preventDefault: noop });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const draft = onSubmit.mock.calls[0]![0];
    expect(draft).toMatchObject({
      id: WITH_LOGO.id,
      name: WITH_LOGO.name,
      url: WITH_LOGO.url,
      blurb: WITH_LOGO.blurb,
      tier: WITH_LOGO.tier,
    });
    expect(draft).not.toHaveProperty("order");
  });

  it("renders the tab's save error inside the dialog, where the Save button is", () => {
    expect(render(WITH_LOGO, { error: "Logo must be PNG, JPEG or WebP" })).toContain(
      "Logo must be PNG, JPEG or WebP",
    );
  });

  it("says it is saving and blocks a second submit while a write is in flight", () => {
    const html = render(WITH_LOGO, { pending: true });
    expect(html).toContain("Saving…");
    expect(html).toContain("disabled");
  });

  // CodeQL js/xss-through-dom, high, on the first cut of this dialog: the
  // preview src was `data:${file.type};base64,...`, which interpolates a
  // browser-supplied MIME type into a URL that lands in an <img src>. The fix
  // is two-part and both halves are pinned here, at source level — there is
  // no DOM in this suite to fire a real file pick through (see the header).
  it("never derives the preview src from the uploaded file", () => {
    const src = readFileSync(fileURLToPath(new URL("../sponsor-editor-dialog.tsx", import.meta.url)), "utf8");
    // Comments stripped first: both removed sinks are quoted in the prose that
    // explains why they are gone, and prose is not what this guards.
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // Shape 1: a data: URL built around the browser's claimed MIME type.
    expect(code).not.toMatch(/data:\$\{/);
    // Shape 2: an object URL minted for the File itself.
    expect(code).not.toContain("createObjectURL");
    // What it is instead: pixels the browser decoded, re-drawn and read back
    // off a canvas, so nothing file-derived reaches the DOM.
    expect(code).toContain("createImageBitmap(file)");
    expect(code).toContain('canvas.toDataURL("image/png")');
  });

  // Two overlapping picks: reading and decoding are both async and the picker
  // stays enabled, so without a guard the SLOWER, older pick lands last and
  // the draft saves a logo the organizer already replaced. Source-level, like
  // the assertions above — there is no DOM here to race two real file picks
  // through, and what must not be deleted is the guard.
  it("lets the latest file pick win, and drops the previous one immediately", () => {
    const src = readFileSync(fileURLToPath(new URL("../sponsor-editor-dialog.tsx", import.meta.url)), "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // A pick claims the sequence before anything awaits…
    expect(code).toMatch(/const seq = \+\+pickSeq\.current;/);
    // …the previous pick's bytes and preview are cleared at that same moment,
    // so a pick that is then rejected cannot leave them behind…
    expect(code).toMatch(/const seq = \+\+pickSeq\.current;[\s\S]{0,200}clearPickedLogo\(\);/);
    // …and every post-await write, success or failure, is gated on the pick
    // still being the current one.
    expect(code.match(/if \(stale\(\)\) return;/g) ?? []).toHaveLength(2);
  });

  it("refuses a file the browser cannot decode as an image", () => {
    const src = readFileSync(fileURLToPath(new URL("../sponsor-editor-dialog.tsx", import.meta.url)), "utf8");
    // renderPreview returns null on a decode failure, and that is a rejection
    // with a reason — not a save that silently carries unpreviewable bytes.
    expect(src).toMatch(/if \(!preview\) \{/);
    expect(src).toContain("could not be decoded as an image");
  });

  it("rejects a file whose type is not one of the three accepted images", () => {
    const src = readFileSync(fileURLToPath(new URL("../sponsor-editor-dialog.tsx", import.meta.url)), "utf8");
    // The draft's logoType is the allowlist's own constant, never file.type.
    expect(src).toContain("asSponsorLogoMime(file.type)");
    expect(src).toMatch(/logoType: mime/);
    expect(src).not.toMatch(/logoType: file\.type/);
  });

  it("offers the picker only the accepted types", () => {
    expect(render(null)).toContain("image/png,image/jpeg,image/webp");
  });

  // The file input is a real <input type="file"> kept visually hidden behind
  // its label, NOT hidden from assistive tech or the keyboard: `hidden` or
  // `display:none` would take it out of the tab order entirely.
  it("keeps the file input reachable, only visually replaced by its label", () => {
    const html = render(null);
    expect(html).toContain('type="file"');
    expect(html).toContain("sr-only");
  });
});
