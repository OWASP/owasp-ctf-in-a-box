// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ChallengeFrame, {
  addChallengeTooltip,
  challengeEditorKey,
  resolveFlagRevealed,
} from "@/components/admin/challenge-frame";
import { describeAdminError } from "@/components/admin/fetch";
import { useAdminResource, type AdminResource } from "@/components/admin/use-admin-resource";
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
  setFlagRevealed,
  onChange,
  onCancel,
}: {
  editor: Editor;
  pending: boolean;
  error: string | null;
  flagRevealed: boolean;
  setFlagRevealed?: (v: boolean) => void;
  onChange?: (draft: Draft) => void;
  onCancel?: () => void;
}) {
  return (
    <div data-testid="mock-form" data-mode={editor.mode} data-revealed={String(flagRevealed)}>
      <span data-testid="form-title">{editor.draft.title}</span>
      <button type="button" data-testid="reveal-flag-btn" onClick={() => setFlagRevealed?.(true)}>
        Reveal flag
      </button>
      <input
        data-testid="form-title-input"
        value={editor.draft.title}
        onChange={(e) => onChange?.({ ...editor.draft, title: e.target.value })}
      />
      <button type="button" data-testid="cancel-editor-btn" onClick={onCancel}>
        Cancel
      </button>
      {pending && <span>saving...</span>}
      {error && <span>{error}</span>}
    </div>
  );
}

type Payload = { id: string; title: string; category: string };

function InteractiveFrameHarness({
  initialRows = [
    { challenge: { id: "c1", title: "Challenge 1", category: "Web" } },
    { challenge: { id: "c2", title: "Challenge 2", category: "Web" } },
  ],
  initialCategories = ["Web"],
}: {
  initialRows?: Row[];
  initialCategories?: string[];
} = {}) {
  const resource = useAdminResource<Row, Challenge, Editor, Payload>({
    endpoint: "/api/admin/challenges",
    describeError: (status, msg) => describeAdminError(status, msg, "error"),
    rows: {
      id: (r) => r.challenge.id,
      order: () => 1,
      withOrder: (r) => r,
    },
    parseList: (data) => ({
      rows: (data.challenges as Row[]) ?? initialRows,
      categories: (data.categories as string[]) ?? initialCategories,
    }),
    loadErrorMessage: "Failed to load",
    parseUpsert: (_data, payload) => ({
      challenge: { id: payload.id, title: payload.title, category: payload.category },
    }),
    toPayload: (e) => ({
      id: e.mode === "edit" ? e.id : "new-id",
      title: e.draft.title,
      category: "Web",
    }),
    initialRows,
    initialCategories,
  });

  return (
    <ChallengeFrame
      knob={<div>knob</div>}
      resource={resource}
      categoryEditor={defaultCategoryEditor}
      newEditor={(_nextOrder, defaultCategory) => ({
        mode: "new",
        draft: { title: `New in ${defaultCategory}` },
      })}
      editorFromRow={(row) => ({
        mode: "edit",
        id: row.challenge.id,
        draft: { title: row.challenge.title },
      })}
      deleteConfirm={(item) => ({
        title: `Delete ${item.title}?`,
        body: "Confirm delete",
        requireType: "",
        confirmLabel: "Delete challenge",
      })}
      meta={(row) => <span>{row.challenge.category}</span>}
      Form={MockForm}
    />
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

describe("ChallengeFrame — DOM interaction tests", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("deleting the currently open challenge closes its editor", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            challenges: [
              { challenge: { id: "c1", title: "Challenge 1", category: "Web" } },
              { challenge: { id: "c2", title: "Challenge 2", category: "Web" } },
            ],
            categories: ["Web"],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<InteractiveFrameHarness />);

    // Open editor for Challenge 1
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByTestId("mock-form")).not.toBeNull();
    expect(screen.getByTestId("form-title").textContent).toBe("Challenge 1");

    // Open row menu for Challenge 1 and click Delete
    fireEvent.click(screen.getByLabelText('More actions for "Challenge 1"'));
    fireEvent.click(
      within(screen.getByRole("group", { name: 'Actions for "Challenge 1"' })).getByRole("button", { name: "Delete" }),
    );

    // Confirm delete dialog
    expect(screen.getByRole("button", { name: "Delete challenge" })).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete challenge" }));
    });

    // Editor for Challenge 1 must be closed (unmounted)
    expect(screen.queryByTestId("mock-form")).toBeNull();
  });

  it("deleting a different challenge leaves the current editor open", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            challenges: [
              { challenge: { id: "c1", title: "Challenge 1", category: "Web" } },
              { challenge: { id: "c2", title: "Challenge 2", category: "Web" } },
            ],
            categories: ["Web"],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<InteractiveFrameHarness />);

    // Open editor for Challenge 1
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByTestId("mock-form")).not.toBeNull();
    expect(screen.getByTestId("form-title").textContent).toBe("Challenge 1");

    // Open row menu for Challenge 2 and click Delete
    fireEvent.click(screen.getByLabelText('More actions for "Challenge 2"'));
    fireEvent.click(
      within(screen.getByRole("group", { name: 'Actions for "Challenge 2"' })).getByRole("button", { name: "Delete" }),
    );

    // Confirm delete dialog for Challenge 2
    expect(screen.getByRole("button", { name: "Delete challenge" })).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete challenge" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/challenges",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ id: "c2" }) }),
    );
    await waitFor(() => expect(screen.queryByLabelText('More actions for "Challenge 2"')).toBeNull());

    // Editor for Challenge 1 must remain open
    expect(screen.getByTestId("mock-form")).not.toBeNull();
    expect(screen.getByTestId("form-title").textContent).toBe("Challenge 1");
  });

  it("switching challenges after revealing a flag re-masks it", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            challenges: [
              { challenge: { id: "c1", title: "Challenge 1", category: "Web" } },
              { challenge: { id: "c2", title: "Challenge 2", category: "Web" } },
            ],
            categories: ["Web"],
          }),
          { status: 200 },
        ),
      ),
    );
    render(<InteractiveFrameHarness />);

    // Open editor for Challenge 1
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("false");

    // Reveal flag
    fireEvent.click(screen.getByTestId("reveal-flag-btn"));
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("true");

    // Switch to Challenge 2
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    expect(screen.getByTestId("form-title").textContent).toBe("Challenge 2");
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("false");
  });

  it("cancelling a challenge switch preserves the revealed flag", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            challenges: [
              { challenge: { id: "c1", title: "Challenge 1", category: "Web" } },
              { challenge: { id: "c2", title: "Challenge 2", category: "Web" } },
            ],
            categories: ["Web"],
          }),
          { status: 200 },
        ),
      ),
    );
    render(<InteractiveFrameHarness />);

    // Open editor for Challenge 1
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("false");

    // Reveal flag
    fireEvent.click(screen.getByTestId("reveal-flag-btn"));
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("true");

    // Make unsaved/dirty changes to Challenge 1
    fireEvent.change(screen.getByTestId("form-title-input"), { target: { value: "Challenge 1 Modified" } });

    // Attempt to switch to Challenge 2 -> discard confirmation modal appears
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Discard changes" })).not.toBeNull();

    // Cancel the draft switch
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    // Challenge 1 editor remains open and flag remains revealed
    expect(screen.getByTestId("mock-form")).not.toBeNull();
    expect((screen.getByTestId("form-title-input") as HTMLInputElement).value).toBe("Challenge 1 Modified");
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("true");
  });

  it("each successive new-challenge draft starts with its flag masked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            challenges: [
              { challenge: { id: "c1", title: "Challenge 1", category: "Web" } },
              { challenge: { id: "c2", title: "Challenge 2", category: "Web" } },
            ],
            categories: ["Web"],
          }),
          { status: 200 },
        ),
      ),
    );
    render(<InteractiveFrameHarness />);

    // Wait for categories/resource to settle so Add challenge is enabled
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Add challenge" }) as HTMLButtonElement).disabled).toBe(false);
    });

    // Open first new draft
    fireEvent.click(screen.getByRole("button", { name: "Add challenge" }));
    expect(screen.getByTestId("mock-form").getAttribute("data-mode")).toBe("new");
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("false");

    // Reveal flag on first draft
    fireEvent.click(screen.getByTestId("reveal-flag-btn"));
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("true");

    // Start successive new draft directly
    fireEvent.click(screen.getByRole("button", { name: "Add challenge" }));

    // The successive new draft must start with flag masked
    expect(screen.getByTestId("mock-form").getAttribute("data-mode")).toBe("new");
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("false");

    // Now test with dirty draft and discard confirmation:
    // Reveal flag on the second draft
    fireEvent.click(screen.getByTestId("reveal-flag-btn"));
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("true");

    // Dirty the second draft
    fireEvent.change(screen.getByTestId("form-title-input"), { target: { value: "Dirty new draft" } });

    // Click Add challenge again -> discard modal appears
    fireEvent.click(screen.getByRole("button", { name: "Add challenge" }));
    expect(screen.getByRole("button", { name: "Discard changes" })).not.toBeNull();

    // Confirm discard to advance to third new draft
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    // Third successive new draft must also start with flag masked
    expect(screen.getByTestId("mock-form").getAttribute("data-mode")).toBe("new");
    expect(screen.getByTestId("mock-form").getAttribute("data-revealed")).toBe("false");
  });

  it("the actual rendered tooltip behavior depends on addChallengeTooltip", () => {
    // 1. Loading state
    render(
      <ChallengeFrame
        knob={<div>knob</div>}
        resource={createMockResource({ loaded: false, categories: ["Web"], listError: null })}
        categoryEditor={defaultCategoryEditor}
        newEditor={(_nextOrder, defaultCategory) => ({ mode: "new", draft: { title: `New in ${defaultCategory}` } })}
        editorFromRow={(row) => ({ mode: "edit", id: row.challenge.id, draft: { title: row.challenge.title } })}
        deleteConfirm={(item) => ({ title: `Delete ${item.title}?`, body: "Confirm", requireType: "", confirmLabel: "Delete" })}
        meta={(row) => <span>{row.challenge.category}</span>}
        Form={MockForm}
      />,
    );
    const loadingBtn = screen.getByRole("button", { name: "Add challenge" });
    expect(loadingBtn.getAttribute("title")).toBe("Loading challenges…");
    expect((loadingBtn as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    // 2. List error state
    render(
      <ChallengeFrame
        knob={<div>knob</div>}
        resource={createMockResource({ loaded: false, categories: ["Web"], listError: "Store offline" })}
        categoryEditor={defaultCategoryEditor}
        newEditor={(_nextOrder, defaultCategory) => ({ mode: "new", draft: { title: `New in ${defaultCategory}` } })}
        editorFromRow={(row) => ({ mode: "edit", id: row.challenge.id, draft: { title: row.challenge.title } })}
        deleteConfirm={(item) => ({ title: `Delete ${item.title}?`, body: "Confirm", requireType: "", confirmLabel: "Delete" })}
        meta={(row) => <span>{row.challenge.category}</span>}
        Form={MockForm}
      />,
    );
    const errorBtn = screen.getByRole("button", { name: "Add challenge" });
    expect(errorBtn.getAttribute("title")).toBe("Could not load challenges — reload the page to try again");
    expect((errorBtn as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    // 3. Empty categories state
    render(
      <ChallengeFrame
        knob={<div>knob</div>}
        resource={createMockResource({ loaded: true, categories: [], listError: null })}
        categoryEditor={defaultCategoryEditor}
        newEditor={(_nextOrder, defaultCategory) => ({ mode: "new", draft: { title: `New in ${defaultCategory}` } })}
        editorFromRow={(row) => ({ mode: "edit", id: row.challenge.id, draft: { title: row.challenge.title } })}
        deleteConfirm={(item) => ({ title: `Delete ${item.title}?`, body: "Confirm", requireType: "", confirmLabel: "Delete" })}
        meta={(row) => <span>{row.challenge.category}</span>}
        Form={MockForm}
      />,
    );
    const emptyCatBtn = screen.getByRole("button", { name: "Add challenge" });
    expect(emptyCatBtn.getAttribute("title")).toBe("Add a category first before adding challenges");
    expect((emptyCatBtn as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    // 4. Ready state: loaded, categories exist, no error -> tooltip is undefined
    render(
      <ChallengeFrame
        knob={<div>knob</div>}
        resource={createMockResource({ loaded: true, categories: ["Web"], listError: null })}
        categoryEditor={defaultCategoryEditor}
        newEditor={(_nextOrder, defaultCategory) => ({ mode: "new", draft: { title: `New in ${defaultCategory}` } })}
        editorFromRow={(row) => ({ mode: "edit", id: row.challenge.id, draft: { title: row.challenge.title } })}
        deleteConfirm={(item) => ({ title: `Delete ${item.title}?`, body: "Confirm", requireType: "", confirmLabel: "Delete" })}
        meta={(row) => <span>{row.challenge.category}</span>}
        Form={MockForm}
      />,
    );
    const readyBtn = screen.getByRole("button", { name: "Add challenge" });
    expect(readyBtn.getAttribute("title")).toBeNull();
    expect((readyBtn as HTMLButtonElement).disabled).toBe(false);
    cleanup();
  });
});
