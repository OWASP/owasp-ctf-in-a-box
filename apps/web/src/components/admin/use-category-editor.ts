"use client";

// The category list's state and writes, shared by the classic and ai admin
// panels (the two modules with organizer-managed categories). Both used to
// carry the same five functions and three useStates; the ONLY inputs that
// differed were the endpoint and the error mapper, so those are parameters.
//
// The category list itself is NOT owned here: it arrives in the same GET as
// the challenge list and a bulk import refreshes both, so the panel's
// resource state owns `categories` and lends this hook a setter. This hook
// owns what is specific to editing the list — the new-name input, the
// in-flight flag, and the last refusal.
//
// Wire contract: every categories POST carries EXACTLY `{categories}` and
// nothing else. `POST /api/admin/<module>` dispatches on the exact key set
// (see each route's header comment) — a stray second key would fall through
// to the challenge-upsert parser and 400 — so `categoriesRequestBody` is the
// one place this body is built, and the modules re-export it so their tests
// can drive it straight into the real route.
//
// Removal is refused while anything still references the category. The
// stores do not enforce this (`setCategories`/`setAiCategories` only
// validate and dedupe), so the refusal lives here, computed from the
// challenge list the panel already holds via `usageCount`.
//
// The decisions are pure and exported: this repo's tests cannot click, so
// "which sentence does a duplicate name produce" has to be provable by call.

import { useState } from "react";
import { type DescribeError, sendJson } from "@/components/admin/fetch";

/** The exact request body a categories POST sends — one key. */
export function categoriesRequestBody(categories: readonly string[]): { categories: string[] } {
  return { categories: [...categories] };
}

type AddCategoryDecision = { kind: "noop" } | { kind: "duplicate"; message: string } | { kind: "add"; next: string[] };

/** What typing a name and pressing Add does: nothing for a blank, a refusal
 *  for a name already present (case-insensitively), otherwise the new list. */
export function addCategoryDecision(input: string, categories: readonly string[]): AddCategoryDecision {
  const name = input.trim();
  if (!name) return { kind: "noop" };
  if (categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
    return { kind: "duplicate", message: `"${name}" is already a category.` };
  }
  return { kind: "add", next: [...categories, name] };
}

/** The exact request body a rename POST sends. Its own shape, not the
 *  `categories` array: replacing the whole list cannot express a rename —
 *  the renamed entry is indistinguishable from one removed plus one added,
 *  which is how the challenges lose their association with it (#304). */
export function renameCategoryRequestBody(from: string, to: string): { renameCategory: { from: string; to: string } } {
  return { renameCategory: { from, to } };
}

type RenameCategoryDecision =
  | { kind: "noop" }
  | { kind: "duplicate"; message: string }
  | { kind: "rename"; from: string; to: string };

/** What committing a rename does: nothing for a blank or an unchanged name, a
 *  refusal when another category already holds it, otherwise the rename. The
 *  store refuses the same cases server-side; this is the sentence an organizer
 *  reads before a round trip. */
export function renameCategoryDecision(
  from: string,
  input: string,
  categories: readonly string[],
): RenameCategoryDecision {
  const to = input.trim();
  if (!to || to === from) return { kind: "noop" };
  // Case-insensitive, like `addCategoryDecision` — except against the entry
  // being renamed, where a change of spelling is the whole point.
  const clash = categories.some((c) => c !== from && c.toLowerCase() === to.toLowerCase());
  if (clash) {
    return { kind: "duplicate", message: `"${to}" is already a category. Pick another name.` };
  }
  return { kind: "rename", from, to };
}

type RemoveCategoryDecision = { kind: "refuse"; message: string } | { kind: "remove" };

/** Refuses to remove a category still in use, naming exactly how many
 *  challenges reference it. */
export function removeCategoryDecision(name: string, count: number): RemoveCategoryDecision {
  if (count > 0) {
    return {
      kind: "refuse",
      message: `Can't remove "${name}" — ${count} challenge${count === 1 ? "" : "s"} still ${count === 1 ? "uses" : "use"} it. Reassign or delete ${count === 1 ? "it" : "them"} first.`,
    };
  }
  return { kind: "remove" };
}

/** The list with the entry at `from` moved to `to`, or null when `to` is out
 *  of range (nothing to write). */
export function moveInList(list: readonly string[], from: number, to: number): string[] | null {
  if (to < 0 || to >= list.length) return null;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export type CategoryEditorState = {
  input: string;
  setInput: (value: string) => void;
  pending: boolean;
  error: string | null;
  add: () => void;
  remove: (name: string) => void;
  move: (from: number, to: number) => void;
  /** The category currently open for renaming, or null. */
  renaming: string | null;
  renameInput: string;
  setRenameInput: (value: string) => void;
  startRename: (name: string) => void;
  cancelRename: () => void;
  commitRename: () => void;
};

export function useCategoryEditor({
  endpoint,
  describeError,
  categories,
  setCategories,
  usageCount,
  afterRename,
}: {
  endpoint: string;
  describeError: DescribeError;
  categories: string[];
  setCategories: (next: string[]) => void;
  /** How many challenges currently file under a category. */
  usageCount: (name: string) => number;
  /** Re-reads the panel's own lists after a successful rename. Required in
   *  practice: the rows on screen still carry the OLD category name, so
   *  without this the list keeps grouping them under a heading that no longer
   *  exists until something else reloads. */
  afterRename?: () => Promise<void>;
}): CategoryEditorState {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  async function postCategories(next: string[]): Promise<{ ok: true; categories: string[] } | { ok: false; message: string }> {
    const result = await sendJson<{ error?: string; categories?: string[] }>(
      endpoint,
      { method: "POST", body: categoriesRequestBody(next) },
      describeError,
    );
    if (!result.ok) return result;
    const { status, data } = result;
    if (!Array.isArray(data.categories)) return { ok: false, message: describeError(status, data.error) };
    return { ok: true, categories: data.categories };
  }

  /** Applies a list optimistically, then keeps the STORED list the route
   *  echoes (validated, deduped) — or restores the previous one on failure. */
  async function applyCategories(next: string[]) {
    const before = categories;
    setCategories(next);
    setPending(true);
    setError(null);
    const result = await postCategories(next);
    setPending(false);
    if (!result.ok) {
      setCategories(before);
      setError(result.message);
      return;
    }
    setCategories(result.categories);
  }

  function add() {
    const decision = addCategoryDecision(input, categories);
    if (decision.kind === "noop") return;
    if (decision.kind === "duplicate") {
      setError(decision.message);
      return;
    }
    setInput("");
    void applyCategories(decision.next);
  }

  function remove(name: string) {
    const decision = removeCategoryDecision(name, usageCount(name));
    if (decision.kind === "refuse") {
      setError(decision.message);
      return;
    }
    setError(null);
    void applyCategories(categories.filter((c) => c !== name));
  }

  function move(from: number, to: number) {
    const next = moveInList(categories, from, to);
    if (!next) return;
    setError(null);
    void applyCategories(next);
  }

  function startRename(name: string) {
    setError(null);
    setRenaming(name);
    // Seeded with the current name: a rename is almost always an edit of what
    // is there (a typo), not a fresh name typed from nothing.
    setRenameInput(name);
  }

  function cancelRename() {
    setRenaming(null);
    setRenameInput("");
  }

  function commitRename() {
    if (renaming === null) return;
    const decision = renameCategoryDecision(renaming, renameInput, categories);
    if (decision.kind === "noop") {
      cancelRename();
      return;
    }
    if (decision.kind === "duplicate") {
      setError(decision.message);
      return;
    }
    void applyRename(decision.from, decision.to);
  }

  /** Not optimistic, unlike `applyCategories`. A rename also rewrites every
   *  challenge in the category, and this client cannot know how many moved
   *  until the route says so — showing the new name before the store confirms
   *  it would claim a move that may not have happened. */
  async function applyRename(from: string, to: string) {
    setPending(true);
    setError(null);
    try {
      const result = await sendJson<{ error?: string; categories?: string[] }>(
        endpoint,
        { method: "POST", body: renameCategoryRequestBody(from, to) },
        describeError,
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (!Array.isArray(result.data.categories)) {
        setError(describeError(result.status, result.data.error));
        return;
      }
      setCategories(result.data.categories);
      cancelRename();
      // Awaited INSIDE the pending window on purpose. `afterRename` is the
      // panel's `reload`, which replaces the shared category list; clearing
      // `pending` first would leave every other category control live during
      // that read, and a move or remove dispatched against the pre-reload list
      // would then persist it — writing a stale list back over a fresh one.
      if (afterRename) await afterRename();
    } finally {
      // `finally`, so a rejected reload does not strand the panel disabled.
      setPending(false);
    }
  }

  return {
    input,
    setInput,
    pending,
    error,
    add,
    remove,
    move,
    renaming,
    renameInput,
    setRenameInput,
    startRename,
    cancelRename,
    commitRename,
  };
}
