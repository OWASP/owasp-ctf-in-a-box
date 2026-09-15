// Presence is not discoverability: sponsor-list.test.tsx and
// sponsor-editor-dialog.test.tsx prove those two components behave, but
// nothing there proves the TAB actually mounts them — a redesign that left
// the old markup in place would pass both files.
//
// The tab's rows arrive through a `useEffect` fetch that never runs under
// `renderToStaticMarkup`, so this asserts the wiring rather than a populated
// list: the list element is in the returned tree, with the props it needs,
// and the logo-size field still names both surfaces it drives.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import AdminSponsorsTab from "../admin-sponsors-tab";
import SponsorList from "../sponsor-list";
import type { AdminSettings } from "@/lib/admin-store";

type ReactEl = { type: unknown; props?: Record<string, unknown> };

function findElement(node: unknown, predicate: (el: ReactEl) => boolean): ReactEl | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!("type" in node)) return null;
  const el = node as ReactEl;
  if (predicate(el)) return el;
  return findElement(el.props?.children, predicate);
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

const settings = { sponsorLogoSize: null } as unknown as AdminSettings;

const props = {
  settings,
  settingsPending: false,
  applyField: vi.fn(async () => true),
  statusOf: () => ({ state: "idle" }),
} as unknown as Parameters<typeof AdminSponsorsTab>[0];

describe("AdminSponsorsTab", () => {
  it("mounts the sponsor list, with the reorder and edit callbacks wired", () => {
    const tree = captureTree(AdminSponsorsTab, props);
    const list = findElement(tree, (el) => el.type === SponsorList);
    expect(list).not.toBeNull();
    expect(typeof list!.props?.onMove).toBe("function");
    expect(typeof list!.props?.onEdit).toBe("function");
    expect(typeof list!.props?.onDelete).toBe("function");
    // Nothing fetched yet (effects do not run in a static render), and the
    // list is told so rather than being handed an empty list to call "none".
    expect(list!.props?.loading).toBe(true);
    expect(list!.props?.rows).toEqual([]);
  });

  it("offers an Add sponsor control, so adding is not a permanently open form", () => {
    const html = renderToStaticMarkup(<AdminSponsorsTab {...props} />);
    expect(html).toContain("Add sponsor");
    // The number box that used to be how an organizer reordered a sponsor.
    expect(html).not.toContain(">Order<");
  });

  it("keeps the logo-size field, naming both surfaces it now drives", () => {
    const html = renderToStaticMarkup(<AdminSponsorsTab {...props} />);
    expect(html).toContain("Sponsor logo size");
    expect(html).toContain("projector display");
  });
});
