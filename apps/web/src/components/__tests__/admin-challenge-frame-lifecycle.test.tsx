import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ChallengeFrame, {
  addChallengeTooltip,
  challengeEditorKey,
  resolveFlagRevealed,
} from "@/components/admin/challenge-frame";
import type { AdminResource } from "@/components/admin/use-admin-resource";
import type { CategoryEditorState } from "@/components/admin/use-category-editor";

type Challenge = { id: string; title: string; category: string };
type Row = { challenge: Challenge };
type Draft = { title: string };
type Editor = { mode: "new"; draft: Draft } | { mode: "edit"; id: string; draft: Draft };

const noop = () => {};

const defaultCategoryEditor: CategoryEditorState = {
  input: "",
  setInput: noop,
  pending: false,
  error: null,
  add: noop,
  remove: noop,
  move: noop,
  renaming: null,
  renameInput: "",
  setRenameInput: noop,
  startRename: noop,
  cancelRename: noop,
  commitRename: noop,
};

function createMockResource(overrides: Partial<AdminResource<Row, Challenge, Editor>> = {}): AdminResource<Row, Challenge, Editor> {
  return {
    rows: [],
    setRows: noop,
    categories: ["Web"],
    setCategories: noop,
    listError: null,
    loaded: true,
    reload: () => Promise.resolve(),
    nextOrder: 1,
    editing: null,
    setEditing: noop,
    openEditor: () => true,
    pendingEditor: null,
    confirmDraftSwitch: noop,
    cancelDraftSwitch: noop,
    formPending: false,
    formError: null,
    cancelEditor: noop,
    submitEditor: () => Promise.resolve(),
    deleteTarget: null,
    deletePending: false,
    deleteError: null,
    requestDelete: noop,
    cancelDelete: noop,
    remove: () => Promise.resolve(),
    reorderPending: false,
    move: () => Promise.resolve(),
    ...overrides,
  };
}

function MockForm({
  editor,
  pending,
  error,
  flagRevealed,
}: {
  editor: Editor;
  pending: boolean;
  error: string | null;
  flagRevealed: boolean;
}) {
  return (
    <div data-testid="mock-form" data-mode={editor.mode} data-revealed={String(flagRevealed)}>
      <span data-testid="form-title">{editor.draft.title}</span>
      {pending && <span>saving...</span>}
      {error && <span>{error}</span>}
    </div>
  );
}

function renderFrame(resource: AdminResource<Row, Challenge, Editor>, extraProps: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <ChallengeFrame
      knob={<div>knob</div>}
      resource={resource}
      categoryEditor={defaultCategoryEditor}
      newEditor={(_nextOrder, defaultCategory) => ({ mode: "new", draft: { title: `New in ${defaultCategory}` } })}
      editorFromRow={(row) => ({ mode: "edit", id: row.challenge.id, draft: { title: row.challenge.title } })}
      deleteConfirm={(item) => ({
        title: `Delete ${item.title}?`,
        body: "Confirm delete",
        requireType: item.title,
        confirmLabel: "Delete challenge",
      })}
      meta={(row) => <span>{row.challenge.category}</span>}
      Form={MockForm}
      {...extraProps}
    />,
  );
}

describe("challengeEditorKey", () => {
  it("switch editor: returns the challenge id for edit-mode rows", () => {
    expect(challengeEditorKey({ mode: "edit", id: "c1", draft: { title: "One" } }, 0)).toBe("c1");
    expect(challengeEditorKey({ mode: "edit", id: "c2", draft: { title: "Two" } }, 0)).toBe("c2");
  });

  it("successive new drafts get distinct keys based on revision counter", () => {
    expect(challengeEditorKey({ mode: "new", draft: { title: "Draft 1" } }, 0)).toBe("new-0");
    expect(challengeEditorKey({ mode: "new", draft: { title: "Draft 2" } }, 1)).toBe("new-1");
  });

  it("returns null when no editor is open", () => {
    expect(challengeEditorKey(null, 0)).toBeNull();
  });
});

describe("resolveFlagRevealed", () => {
  it("switch editor: resets reveal state to masked (false)", () => {
    expect(resolveFlagRevealed(true, "c2", "c1")).toBe(false);
    expect(resolveFlagRevealed(true, "new-1", "new-0")).toBe(false);
    expect(resolveFlagRevealed(true, "new-0", "c1")).toBe(false);
  });

  it("cancelled switch keeps the reveal state intact", () => {
    expect(resolveFlagRevealed(true, "c1", "c1")).toBe(true);
    expect(resolveFlagRevealed(false, "c1", "c1")).toBe(false);
  });
});

describe("addChallengeTooltip", () => {
  it("explains load failed and to reload when listError is set", () => {
    expect(addChallengeTooltip(false, "Failed to load challenges", 0)).toBe(
      "Could not load challenges — reload the page to try again",
    );
    expect(addChallengeTooltip(false, "Failed to load challenges", 2)).toBe(
      "Could not load challenges — reload the page to try again",
    );
  });

  it("shows loading message when !loaded and no listError", () => {
    expect(addChallengeTooltip(false, null, 1)).toBe("Loading challenges…");
  });

  it("explains category required when categories is empty", () => {
    expect(addChallengeTooltip(true, null, 0)).toBe("Add a category first before adding challenges");
  });

  it("returns undefined when loaded, no error, and categories exist", () => {
    expect(addChallengeTooltip(true, null, 3)).toBeUndefined();
  });
});

describe("ChallengeFrame — Add challenge button states", () => {
  it("disables Add challenge while reorderPending is true", () => {
    const resource = createMockResource({ loaded: true, categories: ["Web"] });
    const html = renderFrame(resource, { reorderPending: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add challenge<\/button>/);
  });

  it("disables Add challenge while !loaded even if categories exist", () => {
    const resource = createMockResource({ loaded: false, categories: ["Web"] });
    const html = renderFrame(resource);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Loading challenges…"[\s\S]*?>Add challenge<\/button>/);
  });

  it("disables Add challenge and explains reload when listError is set", () => {
    const resource = createMockResource({ loaded: false, listError: "Could not connect", categories: ["Web"] });
    const html = renderFrame(resource);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="Could not load challenges — reload the page to try again"[\s\S]*?>Add challenge<\/button>/,
    );
  });

  it("disables Add challenge when categories is empty, explaining why in the title", () => {
    const resource = createMockResource({ loaded: true, categories: [] });
    const html = renderFrame(resource);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="Add a category first before adding challenges"[\s\S]*?>Add challenge<\/button>/,
    );
  });

  it("enables Add challenge when loaded and categories exist without errors", () => {
    const resource = createMockResource({ loaded: true, categories: ["Web"] });
    const html = renderFrame(resource);
    expect(html).toMatch(/<button[^>]*class="[^"]*"[^>]*>Add challenge<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Add challenge<\/button>/);
  });
});

describe("ChallengeFrame — listError & accessibility", () => {
  it("renders listError with role='alert' and Retry button with descriptive aria-label", () => {
    const resource = createMockResource({ listError: "Failed to load challenges" });
    const html = renderFrame(resource, { onRetry: noop });
    expect(html).toContain('<p role="alert" class="text-sm text-[#e53e3e]">Failed to load challenges');
    expect(html).toMatch(/<button[^>]*aria-label="Retry loading challenges"[^>]*>Retry<\/button>/);
  });
});
