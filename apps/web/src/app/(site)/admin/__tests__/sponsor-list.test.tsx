// The sponsor list an organizer works in (the "sponsors management is
// terrible" fix). Two things it must actually do, neither of which the
// text-only list it replaced did:
//
//   1. Show each logo, on the dark background it will really appear against,
//      so "did that upload work?" is answerable without leaving the tab.
//   2. Reorder from the row itself — the arrows call back with a direction,
//      and the edge rows' arrows are disabled rather than posting a no-op.
//
// Rendered statically and, where a handler is the point, by invoking the real
// onClick off the element tree: `renderToStaticMarkup`'s HTML keeps a
// `disabled` attribute but drops every closure, so proving what a click DOES
// needs the element object (same approach as admin-controls.test.tsx).

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import SponsorList, { SponsorRow, linkLabel, type SponsorRecord } from "../sponsor-list";

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

const sponsor = (over: Partial<SponsorRecord> & Pick<SponsorRecord, "id" | "name">): SponsorRecord => ({
  url: "https://zzyzx.example/security",
  blurb: "",
  tier: "community",
  order: 0,
  logo: null,
  ...over,
});

const WITH_LOGO = sponsor({
  id: "zzyzx-sec-ab12cd",
  name: "Zzyzx Security Labs",
  tier: "gold",
  logo: { type: "image/png", w: 120, h: 40 },
});
const NO_LOGO = sponsor({ id: "acme-ef34gh", name: "Acme Co", tier: "silver", order: 1 });

const noop = () => {};

function renderList(rows: SponsorRecord[], over: Partial<Parameters<typeof SponsorList>[0]> = {}) {
  return renderToStaticMarkup(
    <SponsorList rows={rows} loading={false} pending={false} onMove={noop} onEdit={noop} onDelete={noop} {...over} />,
  );
}

describe("SponsorList", () => {
  it("renders each sponsor's logo from the box's own logo route", () => {
    const html = renderList([WITH_LOGO]);
    expect(html).toContain(`/api/sponsors/logo/${WITH_LOGO.id}`);
    expect(html).toContain(`${WITH_LOGO.name} logo`);
  });

  // The projector board turns logos into white silhouettes; this list must
  // not, or it hides the exact problem an organizer opened the tab to check.
  it("shows the logo untreated, not as the projector board's silhouette", () => {
    expect(renderList([WITH_LOGO])).not.toContain("brightness-0");
  });

  it("marks a sponsor that has no logo instead of rendering a broken image", () => {
    const html = renderList([NO_LOGO]);
    expect(html).toContain("no logo");
    expect(html).not.toContain(`/api/sponsors/logo/${NO_LOGO.id}`);
  });

  it("shows the tier and the link's host, not the raw URL", () => {
    const html = renderList([WITH_LOGO]);
    expect(html).toContain("gold");
    expect(html).toContain("zzyzx.example/security");
    expect(html).not.toContain("https://zzyzx.example");
  });

  it("separates 'still loading' from 'none configured'", () => {
    expect(renderList([], { loading: true })).toContain("Loading…");
    expect(renderList([])).toContain("No sponsors yet");
  });

  it("renders one row per sponsor", () => {
    const tree = captureTree(SponsorList, {
      rows: [WITH_LOGO, NO_LOGO],
      loading: false,
      pending: false,
      onMove: noop,
      onEdit: noop,
      onDelete: noop,
    } as Parameters<typeof SponsorList>[0]);
    expect(findAll(tree, (el) => el.type === SponsorRow)).toHaveLength(2);
  });
});

describe("SponsorRow — reordering", () => {
  const rowTree = (over: Partial<Parameters<typeof SponsorRow>[0]>, onMove = vi.fn()) =>
    ({
      tree: captureTree(SponsorRow, {
        sponsor: WITH_LOGO,
        isFirst: false,
        isLast: false,
        pending: false,
        onMove,
        onEdit: noop,
        onDelete: noop,
        ...over,
      } as Parameters<typeof SponsorRow>[0]),
      onMove,
    }) as const;

  const arrow = (tree: unknown, label: string) =>
    findAll(tree, (el) => el.type === "button" && el.props?.["aria-label"] === label)[0];

  it("asks to move up with -1 and down with +1", () => {
    const up = rowTree({});
    (arrow(up.tree, `Move ${WITH_LOGO.name} up`)!.props as { onClick: () => void }).onClick();
    expect(up.onMove).toHaveBeenCalledWith(WITH_LOGO.id, -1);

    const down = rowTree({});
    (arrow(down.tree, `Move ${WITH_LOGO.name} down`)!.props as { onClick: () => void }).onClick();
    expect(down.onMove).toHaveBeenCalledWith(WITH_LOGO.id, 1);
  });

  it("disables the arrow that would step off the end of the list", () => {
    const first = rowTree({ isFirst: true }).tree;
    expect(arrow(first, `Move ${WITH_LOGO.name} up`)!.props?.disabled).toBe(true);
    expect(arrow(first, `Move ${WITH_LOGO.name} down`)!.props?.disabled).toBe(false);

    const last = rowTree({ isLast: true }).tree;
    expect(arrow(last, `Move ${WITH_LOGO.name} up`)!.props?.disabled).toBe(false);
    expect(arrow(last, `Move ${WITH_LOGO.name} down`)!.props?.disabled).toBe(true);
  });

  it("disables both arrows while a write is in flight", () => {
    const tree = rowTree({ pending: true }).tree;
    expect(arrow(tree, `Move ${WITH_LOGO.name} up`)!.props?.disabled).toBe(true);
    expect(arrow(tree, `Move ${WITH_LOGO.name} down`)!.props?.disabled).toBe(true);
  });

  it("hands Edit and Delete the whole record, not just its id", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const tree = captureTree(SponsorRow, {
      sponsor: WITH_LOGO,
      isFirst: false,
      isLast: false,
      pending: false,
      onMove: noop,
      onEdit,
      onDelete,
    } as Parameters<typeof SponsorRow>[0]);
    const button = (label: string) =>
      findAll(tree, (el) => el.type === "button" && el.props?.children === label)[0]!;
    (button("Edit").props as { onClick: () => void }).onClick();
    (button("Delete").props as { onClick: () => void }).onClick();
    expect(onEdit).toHaveBeenCalledWith(WITH_LOGO);
    expect(onDelete).toHaveBeenCalledWith(WITH_LOGO);
  });
});

describe("linkLabel", () => {
  it("drops the scheme and a bare trailing slash", () => {
    expect(linkLabel("https://example.com/")).toBe("example.com");
    expect(linkLabel("https://example.com/team")).toBe("example.com/team");
  });

  it("falls back to the stored string when it will not parse", () => {
    expect(linkLabel("not a url")).toBe("not a url");
  });
});
