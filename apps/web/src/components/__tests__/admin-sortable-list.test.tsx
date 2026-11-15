// The drag-and-keyboard sortable row list the quiz and classic admin panels
// share. Drag events cannot be simulated in this repo's tests (no
// testing-library, vitest's node environment), and by design the list only
// works out a pair of indices for the panel's `onMove` — so what is proven
// here is the markup an organizer and their screen reader get: the intro
// sentence, one row per item with its title and meta line, keyboard move
// buttons with per-row aria-labels and the right disabled states, Edit and
// Delete, and the empty placeholder.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SortableList, { bucketRows } from "@/components/admin/sortable-list";

type Row = { item: { id: string; title: string; order: number; group?: string } };
const rows: Row[] = [
  { item: { id: "a", title: "First thing", order: 1 } },
  { item: { id: "b", title: "Second thing", order: 2 } },
];
const noop = () => {};

function render(overrides: Partial<Parameters<typeof SortableList<Row>>[0]> = {}) {
  return renderToStaticMarkup(
    <SortableList<Row>
      rows={rows}
      keyOf={(r) => r.item.id}
      titleOf={(r) => r.item.title}
      meta={(r) => <>{r.item.order} pts</>}
      intro="Drag a thing to reorder it, or use Move up / Move down."
      emptyText="No things yet."
      reorderPending={false}
      onMove={noop}
      onEdit={noop}
      onDelete={noop}
      {...overrides}
    />,
  );
}

describe("SortableList", () => {
  it("renders the empty placeholder and nothing else when there are no rows", () => {
    const html = render({ rows: [] });
    expect(html).toContain("No things yet.");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("Drag a thing");
  });

  it("renders the intro and one row per item with its title and meta line", () => {
    const html = render();
    expect(html).toContain("Drag a thing to reorder it, or use Move up / Move down.");
    expect(html).toContain("First thing");
    expect(html).toContain("Second thing");
    expect(html).toContain("2 pts");
    expect(html.match(/<li /g)?.length).toBe(2);
  });

  // Audit F16. Each panel used to print the row's stored `order` field in its
  // own meta line. That field is not a position in anything on screen: on a
  // board seeded per category it repeats, and four rows read #1 under a
  // sentence promising "Contestants see them in this order".
  /** The rendered position badges, in document order. Matched on the badge's
   *  own element rather than the raw text: Tailwind class names carry hex
   *  colours like `bg-[#1d4ed8]`, so a bare search for "#1" finds five of
   *  them and proves nothing. */
  const positions = (html: string) => [...html.matchAll(/<span class="tabular-nums">#(\d+)<\/span>/g)].map((m) => m[1]);

  it("numbers rows by where they sit, not by any field the panel passes", () => {
    expect(positions(render())).toEqual(["1", "2"]);
  });

  it("restarts the numbering in each category, because that is what the reader sees", () => {
    const grouped: Row[] = [
      { item: { id: "a", title: "Alpha", order: 4, group: "Web" } },
      { item: { id: "b", title: "Bravo", order: 7, group: "Web" } },
      { item: { id: "c", title: "Charlie", order: 9, group: "Crypto" } },
    ];
    const html = render({ rows: grouped, groupOf: (r) => r.item.group!, groups: ["Web", "Crypto"] });

    // Web numbers 1, 2; Crypto starts again at 1. Charlie opens its group, so
    // it reads #1 there despite carrying a stored order of 9 — the number an
    // organizer reads now matches the row they are looking at.
    expect(positions(html)).toEqual(["1", "2", "1"]);
    // Non-vacuity: those rows really did render, stored orders and all.
    expect(html).toContain("Charlie");
    expect(html).toContain("9 pts");
  });

  it("gives every row keyboard move buttons named after it, plus Edit and Delete", () => {
    const html = render();
    expect(html).toContain('aria-label="Move &quot;First thing&quot; up"');
    expect(html).toContain('aria-label="Move &quot;Second thing&quot; down"');
    expect(html.match(/>Edit</g)?.length).toBe(2);
    expect(html.match(/>Delete</g)?.length).toBe(2);
  });

  it("keeps Edit on the row and folds Move up / Move down / Delete into a per-row ⋯ menu, Delete in a neutral colour", () => {
    const html = render();
    // One native <details> menu per row, closed, named after the row.
    expect(html.match(/<details/g)?.length).toBe(2);
    expect(html).not.toContain("<details open");
    expect(html).toContain('aria-label="More actions for &quot;First thing&quot;"');
    // Edit is outside the menu; the menu holds the rarer actions.
    expect(html).toMatch(/>Edit<\/button><details/);
    expect(html).toMatch(/<details[\s\S]*?Move up[\s\S]*?Move down[\s\S]*?Delete[\s\S]*?<\/details>/);
    // Danger colour is for the confirmation the item opens, not the item.
    expect(html).not.toContain("#e53e3e");
  });

  it("without onMove renders no grip, no drag and no Move items — only Edit and Delete", () => {
    const html = render({ onMove: undefined });
    expect(html).not.toContain("⠿");
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain("Move up");
    expect(html.match(/>Edit</g)?.length).toBe(2);
    expect(html.match(/>Delete</g)?.length).toBe(2);
  });

  describe("grouped", () => {
    const grouped: Row[] = [
      { item: { id: "c1", title: "Crypto one", order: 1, group: "Crypto" } },
      { item: { id: "f1", title: "Forensics one", order: 2, group: "Forensics" } },
      { item: { id: "c2", title: "Crypto two", order: 3, group: "Crypto" } },
    ];

    it("buckets rows by group in the panel's group order, keeping each row's global index", () => {
      const buckets = bucketRows(grouped, (r) => r.item.group!, ["Forensics", "Crypto", "Web"]);
      expect(buckets.map((b) => b.group)).toEqual(["Forensics", "Crypto", "Web"]);
      expect(buckets[1].items.map((i) => [i.row.item.id, i.index])).toEqual([
        ["c1", 0],
        ["c2", 2],
      ]);
      expect(buckets[2].items).toEqual([]);
    });

    it("appends a group the panel did not name rather than dropping its rows", () => {
      const buckets = bucketRows(grouped, (r) => r.item.group!, ["Crypto"]);
      expect(buckets.map((b) => b.group)).toEqual(["Crypto", "Forensics"]);
    });

    it("is one flat bucket without groupOf", () => {
      expect(bucketRows(grouped, undefined, undefined)).toEqual([
        { group: null, items: grouped.map((row, index) => ({ row, index })) },
      ]);
    });

    it("renders a heading with the count per group, an empty group's placeholder, and moves within the group", () => {
      const html = render({ rows: grouped, groupOf: (r) => r.item.group!, groups: ["Crypto", "Forensics", "Web"] });
      expect(html).toMatch(/<h4[^>]*>Crypto<span[^>]*>2<\/span><\/h4>/);
      expect(html).toMatch(/<h4[^>]*>Web<span[^>]*>0<\/span><\/h4>/);
      expect(html).toContain("Nothing here yet.");
      // Crypto two is last IN ITS GROUP, so Move down is disabled although a
      // Forensics row sits after Crypto one in the global order.
      expect(html).toMatch(/<button[^>]*aria-label="Move &quot;Crypto two&quot; down"[^>]*disabled=""/);
      expect(html).not.toMatch(/<button[^>]*aria-label="Move &quot;Crypto one&quot; down"[^>]*disabled=""/);
      // Forensics one is alone in its group: both moves disabled.
      expect(html).toMatch(/<button[^>]*aria-label="Move &quot;Forensics one&quot; up"[^>]*disabled=""/);
      expect(html).toMatch(/<button[^>]*aria-label="Move &quot;Forensics one&quot; down"[^>]*disabled=""/);
    });
  });

  it("disables Move up on the first row and Move down on the last, only", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-label="Move &quot;First thing&quot; up"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="Move &quot;Second thing&quot; down"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Move &quot;First thing&quot; down"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Move &quot;Second thing&quot; up"[^>]*disabled=""/);
  });

  it("marks rows draggable, and stops both drag and the move buttons while a reorder is in flight", () => {
    expect(render()).toContain('draggable="true"');
    const busy = render({ reorderPending: true });
    expect(busy).toContain('draggable="false"');
    expect(busy).toMatch(/<button[^>]*aria-label="Move &quot;First thing&quot; down"[^>]*disabled=""/);
  });

  it("hides the grip glyph from assistive tech", () => {
    expect(render()).toMatch(/<span aria-hidden="true"[^>]*>⠿<\/span>/);
  });
});
