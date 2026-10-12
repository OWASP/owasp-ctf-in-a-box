// The category manager the classic and ai admin panels share — byte-identical
// JSX and identical add/remove/move logic before extraction. The decisions
// (duplicate name, still-in-use refusal, move bounds) are pure and exported
// because this repo's tests render with `renderToStaticMarkup` in vitest's
// node environment and cannot click; the list markup is proven statically.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CategoryEditor from "@/components/admin/category-editor";
import {
  CATEGORIES_RELOADED_MESSAGE,
  addCategoryDecision,
  categoriesRequestBody,
  categoryWriteFailureMessage,
  moveInList,
  removeCategoryDecision,
  renameCategoryDecision,
  renameCategoryRequestBody,
} from "@/components/admin/use-category-editor";

const noop = () => {};

describe("categoriesRequestBody", () => {
  it("carries exactly the new list and the list it was edited from, as fresh arrays", () => {
    const input = ["Web", "Crypto"];
    const before = ["Web"];
    const body = categoriesRequestBody(input, before);
    expect(Object.keys(body)).toEqual(["categories", "expected"]);
    expect(body.categories).toEqual(input);
    expect(body.categories).not.toBe(input);
    expect(body.expected).toEqual(before);
    expect(body.expected).not.toBe(before);
  });
});

describe("categoryWriteFailureMessage", () => {
  it("tells the organizer the list was re-read when another edit won the race", () => {
    expect(categoryWriteFailureMessage({ status: 409, message: "server words" }, true)).toBe(
      CATEGORIES_RELOADED_MESSAGE,
    );
    expect(CATEGORIES_RELOADED_MESSAGE).toMatch(/changed/i);
    expect(CATEGORIES_RELOADED_MESSAGE).toMatch(/try again/i);
  });

  it("keeps the server's own sentence when nothing was re-read, or for any other failure", () => {
    expect(categoryWriteFailureMessage({ status: 409, message: "Reload and try again." }, false)).toBe(
      "Reload and try again.",
    );
    expect(categoryWriteFailureMessage({ status: 400, message: "too long" }, true)).toBe("too long");
    expect(categoryWriteFailureMessage({ message: "Couldn't reach the server — try again." }, true)).toBe(
      "Couldn't reach the server — try again.",
    );
  });
});

describe("addCategoryDecision", () => {
  it("is a no-op for a blank name", () => {
    expect(addCategoryDecision("   ", ["Web"])).toEqual({ kind: "noop" });
  });

  it("refuses a name already present, case-insensitively, with the exact sentence", () => {
    expect(addCategoryDecision(" web ", ["Web"])).toEqual({ kind: "duplicate", message: '"web" is already a category.' });
  });

  it("appends the trimmed name", () => {
    expect(addCategoryDecision(" Crypto ", ["Web"])).toEqual({ kind: "add", next: ["Web", "Crypto"] });
  });
});

describe("removeCategoryDecision", () => {
  it("refuses while challenges still use it, naming the count with the right grammar", () => {
    expect(removeCategoryDecision("Web", 1)).toEqual({
      kind: "refuse",
      message: 'Can\'t remove "Web" — 1 challenge still uses it. Reassign or delete it first.',
    });
    expect(removeCategoryDecision("Web", 3)).toEqual({
      kind: "refuse",
      message: 'Can\'t remove "Web" — 3 challenges still use it. Reassign or delete them first.',
    });
  });

  it("removes an unused category", () => {
    expect(removeCategoryDecision("Web", 0)).toEqual({ kind: "remove" });
  });
});

describe("moveInList", () => {
  it("moves an entry to the target index", () => {
    expect(moveInList(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveInList(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
  });

  it("returns null for an out-of-range target, so nothing is written", () => {
    expect(moveInList(["a", "b"], 0, -1)).toBeNull();
    expect(moveInList(["a", "b"], 1, 2)).toBeNull();
  });
});

describe("CategoryEditor", () => {
  function render(overrides: Partial<Parameters<typeof CategoryEditor>[0]> = {}) {
    return renderToStaticMarkup(
      <CategoryEditor
        categories={["Web", "Crypto"]}
        input=""
        error={null}
        pending={false}
        onInput={noop}
        onAdd={noop}
        onRemove={noop}
        onMove={noop}
        {...overrides}
      />,
    );
  }

  it("renders every category as a chip with keyboard move and remove controls", () => {
    const html = render();
    expect(html).toContain("Categories");
    expect(html).toContain("Web");
    expect(html).toContain("Crypto");
    // Inline chips move left/right, not up/down; every control is named
    // after its chip for assistive tech.
    expect(html).toContain('aria-label="Move &quot;Web&quot; left"');
    expect(html).toContain('aria-label="Move &quot;Crypto&quot; right"');
    expect(html).toContain('aria-label="Remove &quot;Web&quot;"');
    expect(html).toContain("Remove");
    expect(html).toContain("Add category");
    expect(html).not.toContain("<details");
  });

  it("keeps the chip controls in the tree at low opacity, revealed on hover or focus, never hidden", () => {
    const html = render();
    expect(html).toMatch(/opacity-40[^"]*group-focus-within:opacity-100[^"]*group-hover:opacity-100/);
    expect(html).not.toContain("opacity-0");
  });

  it("gives Remove a neutral colour — danger is for the confirmations that destroy something", () => {
    const html = render();
    expect(html).not.toContain("#e53e3e]/40");
  });

  it("disables Move left on the first chip and Move right on the last", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-label="Move &quot;Web&quot; left"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="Move &quot;Crypto&quot; right"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Move &quot;Web&quot; right"[^>]*disabled=""/);
  });

  it("shows the empty-list placeholder", () => {
    expect(render({ categories: [] })).toContain("No categories yet — add one before authoring a challenge.");
  });

  it("disables Add category until something is typed", () => {
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Add category</);
    expect(render({ input: "Pwn" })).not.toMatch(/<button[^>]*disabled=""[^>]*>Add category</);
  });

  it("renders the error line when there is one", () => {
    expect(render({ error: '"Web" is already a category.' })).toContain(
      '<p class="text-sm text-[#e53e3e]">&quot;Web&quot; is already a category.</p>',
    );
  });
});

// #304. A category could be added and removed but never renamed, and
// `removeCategory` refuses while any challenge uses it — so a typo in a
// category ten challenges carried meant editing all ten.
describe("renameCategoryRequestBody", () => {
  it("carries its own shape, never the categories array", () => {
    // The array shape cannot express a rename: a renamed entry is
    // indistinguishable from one removed plus one added, which is exactly how
    // the challenges lose their association with it.
    const body = renameCategoryRequestBody("Webb", "Web");
    expect(Object.keys(body)).toEqual(["renameCategory"]);
    expect(body.renameCategory).toEqual({ from: "Webb", to: "Web" });
    expect(body).not.toHaveProperty("categories");
  });
});

describe("renameCategoryDecision", () => {
  it("renames to a genuinely new name", () => {
    expect(renameCategoryDecision("Webb", " Web ", ["Webb", "Crypto"])).toEqual({
      kind: "rename",
      from: "Webb",
      to: "Web",
    });
  });

  it("is a no-op for a blank name or an unchanged one", () => {
    expect(renameCategoryDecision("Web", "   ", ["Web"])).toEqual({ kind: "noop" });
    expect(renameCategoryDecision("Web", "Web", ["Web"])).toEqual({ kind: "noop" });
  });

  it("refuses a name another category already holds, case-insensitively", () => {
    const decision = renameCategoryDecision("Crypto", "web", ["Web", "Crypto"]);
    expect(decision.kind).toBe("duplicate");
    expect(decision).toHaveProperty("message", expect.stringContaining("already a category"));
  });

  it("allows a change of spelling on the entry being renamed", () => {
    // "web" -> "Web" clashes only with itself, which is the whole point.
    expect(renameCategoryDecision("web", "Web", ["web", "Crypto"])).toEqual({
      kind: "rename",
      from: "web",
      to: "Web",
    });
  });
});

describe("CategoryEditor — the rename affordance", () => {
  const props = {
    categories: ["Web", "Crypto"],
    input: "",
    error: null,
    pending: false,
    onInput: noop,
    onAdd: noop,
    onRemove: noop,
    onMove: noop,
  };

  it("offers a named Rename control on every chip", () => {
    const html = renderToStaticMarkup(<CategoryEditor {...props} />);
    expect(html).toContain('aria-label="Rename &quot;Web&quot;"');
    expect(html).toContain('aria-label="Rename &quot;Crypto&quot;"');
  });

  it("turns the chip being renamed into a labelled input, and only that chip", () => {
    const html = renderToStaticMarkup(<CategoryEditor {...props} renaming="Web" renameInput="Webb" />);
    expect(html).toMatch(/<input[^>]*value="Webb"/);
    expect(html).toContain(">Save<");
    expect(html).toContain(">Cancel<");
    // The other chip is untouched — still a plain chip with its controls.
    expect(html).toContain('aria-label="Rename &quot;Crypto&quot;"');
    // And the renamed one no longer offers a rename BUTTON. Asserted on the
    // pencil control rather than on the label: the edit input carries the same
    // `aria-label` by design, so a bare "does not contain Rename Web" check
    // passes on markup that is correct and fails on markup that is too — it
    // proves nothing either way.
    expect(html.match(/✎/g) ?? []).toHaveLength(1);
    expect(html).not.toMatch(/Web<\/span>/);
  });

  it("holds the other chips' Rename while one is open, so a draft is not lost", () => {
    // `startRename` replaces the draft outright, so a second Rename click
    // would discard whatever was typed into the first with nothing said —
    // the same failure the unsaved-draft guard exists for on the module forms.
    const html = renderToStaticMarkup(<CategoryEditor {...props} renaming="Web" renameInput="Webb" />);
    expect(html).toMatch(/<button[^>]*aria-label="Rename &quot;Crypto&quot;"[^>]*disabled=""/);
  });

  it("leaves Move and Remove alone on the other chips", () => {
    // They are keyed by name and do not touch the open draft, so disabling
    // them would cost an organizer a legitimate action for no gain.
    const html = renderToStaticMarkup(<CategoryEditor {...props} renaming="Web" renameInput="Webb" />);
    expect(html).not.toMatch(/<button[^>]*aria-label="Remove &quot;Crypto&quot;"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Move &quot;Crypto&quot; left"[^>]*disabled=""/);
  });

  it("says that renaming carries the challenges across", () => {
    // The one thing an organizer cannot see for themselves before clicking.
    expect(renderToStaticMarkup(<CategoryEditor {...props} />)).toContain("carries its challenges across");
  });
});
