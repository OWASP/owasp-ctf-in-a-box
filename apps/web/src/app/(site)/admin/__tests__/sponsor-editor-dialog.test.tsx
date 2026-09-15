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

  // The file input is a real <input type="file"> kept visually hidden behind
  // its label, NOT hidden from assistive tech or the keyboard: `hidden` or
  // `display:none` would take it out of the tab order entirely.
  it("keeps the file input reachable, only visually replaced by its label", () => {
    const html = render(null);
    expect(html).toContain('type="file"');
    expect(html).toContain("sr-only");
    expect(html).toContain("image/png,image/jpeg,image/webp");
  });
});
