"use client";

// The list-plus-editor state every module admin panel (quiz, classic, ai)
// runs on, once. Each panel used to hold the same dozen useStates — the rows,
// the category list, the list-error line, the loaded flag that gates the
// inventory report, the open editor with its pending/error pair, the delete
// target with its pending/error pair, the reorder flag — and the same five
// async flows over them: the mount-time GET, the upsert POST, the reorder
// write-back, the DELETE, and the refresh. What differed per module is the
// config: endpoint, error mapper, how to read a row's id and order, how to
// turn a GET body into rows, how to turn an upsert reply into the stored row,
// and how to turn an editor into its POST body.
//
// Every failure is a value, never a throw: `loadResource` and `postRow`
// resolve to a result union, so the mount effect, the Retry click and the
// import refresh all handle exactly one shape. The mount effect calls the
// loader and confines its state writes to the `.then` callback, so an
// unmount before the reply lands abandons the load without touching state
// — and so `react-hooks/set-state-in-effect` sees no setState in the effect
// body.
//
// Two things stay the panel's own on purpose: the pure model (draft types,
// validation, payload builders — those are the module's shape) and what the
// list looks like. This hook decides when a write happens and what state it
// moves; the panel decides what is written and what is shown.

import { useEffect, useState } from "react";
import { type DescribeError, parseJson, sendJson } from "@/components/admin/fetch";
import {
  type RowAccessors,
  changedOrderRows,
  nextOrder as nextOrderOf,
  reorderRows,
  sortByOrder,
  upsertRow,
} from "@/components/admin/ordered-rows";

/** The baseline an open editor is compared against.
 *
 *  Three cases, kept apart deliberately. `none` is "no editor is open", which
 *  is clean. `unserializable` is "an editor is open and we could not record
 *  what it looked like" — which must count as DIRTY: collapsing it into `none`
 *  made the one case the fallback exists for skip its own confirmation and
 *  replace the draft silently, the exact failure being guarded against. */
type EditorSnapshot = { kind: "none" } | { kind: "value"; json: string } | { kind: "unserializable" };

/** Records what an editor looks like at the moment it opens. */
export function snapshotEditor<Editor>(editor: Editor): EditorSnapshot {
  try {
    return { kind: "value", json: JSON.stringify(editor) };
  } catch {
    // No draft type has a cycle. If one ever does, the cost of being wrong is
    // a confirmation nobody needed, not work thrown away.
    return { kind: "unserializable" };
  }
}

/** Whether the open editor has been touched since it opened.
 *
 *  Compared by serialized value, not by reference: the panels replace the
 *  whole editor object on every keystroke (`setEditing({...editing, draft})`),
 *  so identity always differs and only the content answers the question.
 *
 *  Exported for direct testing: this repo's tests render to static markup and
 *  cannot type into a form. */
export function editorIsDirty<Editor>(current: Editor | null, snapshot: EditorSnapshot): boolean {
  if (current === null || snapshot.kind === "none") return false;
  if (snapshot.kind === "unserializable") return true;
  try {
    return JSON.stringify(current) !== snapshot.json;
  } catch {
    return true;
  }
}

/** Whether deleting `id` should close the open editor.
 *
 *  Closes when the editor is editing the item being deleted; stays open for
 *  a new-mode draft or when editing a different item. Exported for direct
 *  testing. */
export function closesOnDelete<Editor>(editing: Editor | null, id: string): boolean {
  if (!editing || typeof editing !== "object") return false;
  return "id" in editing && (editing as { id: unknown }).id === id;
}

type LoadResult<Row> = { ok: true; rows: Row[]; categories: string[] } | { ok: false; message: string };

type PostResult<Row> = { ok: true; row: Row } | { ok: false; message: string };

type AdminResourceConfig<Row, Editor, Payload> = {
  /** `/api/admin/<module>` — GET lists, POST upserts, DELETE removes. */
  endpoint: string;
  describeError: DescribeError;
  rows: RowAccessors<Row>;
  /** Reads a 2xx GET body into rows (unsorted is fine) and categories (`[]`
   *  for a module without them). */
  parseList: (data: Record<string, unknown>) => { rows: Row[]; categories: string[] };
  /** What the list-error line says when the GET never got an answer. */
  loadErrorMessage: string;
  /** Reads a 2xx upsert body into the STORED row (the route echoes what it
   *  wrote, which may differ from the payload), or null when the body lacks
   *  the record — treated as a failure described with the reply's status. */
  parseUpsert: (data: Record<string, unknown>, payload: Payload) => Row | null;
  toPayload: (editor: Editor) => Payload;
  /** The POST body that re-saves an existing row unchanged apart from its
   *  order — what the reorder write-back sends. Absent for a module without
   *  reordering, whose `move` is then a no-op. */
  rowPayload?: (row: Row) => Payload;
  initialRows: readonly Row[];
  initialCategories: readonly string[];
  /** Seeds the `loaded` flag. Test seam only — see the note at its useState. */
  initialLoaded?: boolean;
  /** Called after every successful write to the list (upsert, reorder,
   *  delete) — the quiz and classic panels retire a stale import summary
   *  here (#127). */
  onWrite?: () => void;
};

/** One GET of the module's lists, resolved to a value. Exported for direct
 *  testing against a stubbed `fetch`. */
export async function loadResource<Row, Editor, Payload>(
  config: Pick<AdminResourceConfig<Row, Editor, Payload>, "endpoint" | "describeError" | "rows" | "parseList" | "loadErrorMessage">,
): Promise<LoadResult<Row>> {
  try {
    const res = await fetch(config.endpoint);
    const data = await parseJson<Record<string, unknown> & { error?: string }>(res);
    if (!res.ok) return { ok: false, message: config.describeError(res.status, data.error) };
    const { rows, categories } = config.parseList(data);
    return { ok: true, rows: sortByOrder(rows, config.rows), categories };
  } catch {
    return { ok: false, message: config.loadErrorMessage };
  }
}

/** One upsert POST, resolved to the stored row or a message. Exported for
 *  direct testing against a stubbed `fetch`. */
export async function postRow<Row, Editor, Payload>(
  config: Pick<AdminResourceConfig<Row, Editor, Payload>, "endpoint" | "describeError" | "parseUpsert">,
  payload: Payload,
): Promise<PostResult<Row>> {
  const result = await sendJson<Record<string, unknown> & { error?: string }>(
    config.endpoint,
    { method: "POST", body: payload },
    config.describeError,
  );
  if (!result.ok) return result;
  const row = config.parseUpsert(result.data, payload);
  if (row === null) return { ok: false, message: config.describeError(result.status, result.data.error) };
  return { ok: true, row };
}

type ReorderOutcome<Row> = { ok: true } | { ok: false; message: string; fresh: LoadResult<Row> };

/** The reorder write-back: re-saves each changed row, in order, through the
 *  upsert route. On the FIRST failure it stops and re-reads the lists from
 *  the store — earlier rows are already stored with their new order, so the
 *  pre-move list is no longer what the store has (#283) — and returns the
 *  reorder's own message alongside that fresh read. Exported for direct
 *  testing against a stubbed `fetch`. */
export async function writeBackReorder<Row, Editor, Payload>(
  config: Pick<AdminResourceConfig<Row, Editor, Payload>, "endpoint" | "describeError" | "rows" | "parseList" | "loadErrorMessage" | "parseUpsert">,
  changed: readonly Row[],
  rowPayload: (row: Row) => Payload,
): Promise<ReorderOutcome<Row>> {
  for (const row of changed) {
    const result = await postRow(config, rowPayload(row));
    if (!result.ok) return { ok: false, message: result.message, fresh: await loadResource(config) };
  }
  return { ok: true };
}

export type AdminResource<Row, Item, Editor> = {
  rows: Row[];
  setRows: (update: (prev: Row[]) => Row[]) => void;
  categories: string[];
  setCategories: (next: string[]) => void;
  /** The list-error line, or null. */
  listError: string | null;
  /** True once a real read has landed — gates the inventory report so the
   *  shell never hears "0 items" from the pre-hydration seed. */
  loaded: boolean;
  /** Re-reads the lists from the store. A manual Retry, or an import's
   *  refresh — never called from an effect. */
  reload: () => Promise<void>;
  /** The position a brand-new item takes. */
  nextOrder: number;

  editing: Editor | null;
  /** Records a change to the OPEN editor — what the form calls per keystroke.
   *  To open a different one, use `openEditor`, which guards the draft. */
  setEditing: (editor: Editor | null) => void;
  /** Opens `next` for editing, or — when the open draft has unsaved changes —
   *  parks it in `pendingEditor` and waits to be told what to do (audit F17).
   *  Every Edit and Add button goes through this. Returns whether `next` was
   *  opened immediately. */
  openEditor: (next: Editor) => boolean;
  /** The editor waiting behind a discard confirmation, or null. Non-null is
   *  the panel's cue to render one. */
  pendingEditor: Editor | null;
  /** Discards the current draft and opens the parked one. */
  confirmDraftSwitch: () => void;
  /** Keeps the current draft; the parked editor is dropped. */
  cancelDraftSwitch: () => void;
  formPending: boolean;
  formError: string | null;
  /** Closes the form unless a save is in flight. */
  cancelEditor: () => void;
  submitEditor: (editor: Editor) => Promise<void>;

  deleteTarget: Item | null;
  deletePending: boolean;
  deleteError: string | null;
  /** Opens the delete confirmation for `item`. */
  requestDelete: (item: Item) => void;
  cancelDelete: () => void;
  /** The DELETE itself; on success the row leaves the list and the
   *  confirmation closes. */
  remove: (id: string) => Promise<void>;

  reorderPending: boolean;
  /** Applies a move optimistically, then writes back only the rows whose
   *  order actually changed. On a failure the list is re-read from the store
   *  (rows written before the failure keep their new order there) rather
   *  than left showing an arrangement the store doesn't have. */
  move: (from: number, to: number) => Promise<void>;
};

export function useAdminResource<Row, Item, Editor, Payload>(
  config: AdminResourceConfig<Row, Editor, Payload>,
): AdminResource<Row, Item, Editor> {
  const { rows: accessors, initialRows, initialCategories, initialLoaded = false, onWrite } = config;

  const [rows, setRows] = useState<Row[]>(() => sortByOrder(initialRows, accessors));
  const [categories, setCategories] = useState<string[]>([...initialCategories]);
  const [listError, setListError] = useState<string | null>(null);
  // False until the mount fetch settles. An empty list and an unread one are
  // different answers (issue #331), so this gates the lists' empty copy.
  // `initialLoaded` is the same test seam as `initialRows`: renderToStaticMarkup
  // never runs the mount effect, so a test that wants the SETTLED-empty state
  // has no other way to reach it.
  const [loaded, setLoaded] = useState(initialLoaded);

  const [editing, setEditing] = useState<Editor | null>(null);
  // What the open editor looked like when it opened, serialized — the baseline
  // `editorIsDirty` compares against. Held as state rather than a ref so a
  // render that reads it is never a render behind.
  const [openedAs, setOpenedAs] = useState<EditorSnapshot>({ kind: "none" });
  const [pendingEditor, setPendingEditor] = useState<Editor | null>(null);
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Item | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [reorderPending, setReorderPending] = useState(false);

  /** Replaces local state with a fresh read of the store. Shared by the mount
   *  effect and `reload`, so an import's refresh and a Retry click land the
   *  same way the first load did. */
  function applyLoad(result: LoadResult<Row>) {
    if (!result.ok) {
      setListError(result.message);
      return;
    }
    setRows(result.rows);
    setCategories(result.categories);
    setListError(null);
    setLoaded(true);
  }

  // First-paint data comes from the seed (or, in production, is simply
  // empty); this replaces it with the live lists once mounted in the browser.
  // Never runs under `renderToStaticMarkup`.
  useEffect(() => {
    let cancelled = false;
    void loadResource(config).then((result) => {
      if (!cancelled) applyLoad(result);
    });
    return () => {
      cancelled = true;
    };
    // Mount-only by design: the endpoint and parsers are fixed for the life
    // of a panel, and re-running on every config identity would refetch on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload(): Promise<void> {
    applyLoad(await loadResource(config));
  }

  async function submitEditor(editor: Editor): Promise<void> {
    setFormPending(true);
    setFormError(null);
    const result = await postRow(config, config.toPayload(editor));
    setFormPending(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setRows((prev) => upsertRow(prev, result.row, accessors));
    onWrite?.();
    setEditing(null);
    setOpenedAs({ kind: "none" });
  }

  /** The one place an editor is opened. A half-written question used to
   *  vanish the moment Edit was clicked on the next row, or Add on a board
   *  where the form sits below the list and every list control stays live
   *  while editing (audit F17). A save in flight is left alone entirely —
   *  swapping the subject out from under an in-flight POST is worse than
   *  making the organizer wait a moment. */
  function openEditor(next: Editor): boolean {
    if (formPending) return false;
    if (editorIsDirty(editing, openedAs)) {
      setPendingEditor(next);
      return false;
    }
    applyEditor(next);
    return true;
  }

  function applyEditor(next: Editor) {
    setPendingEditor(null);
    setFormError(null);
    setEditing(next);
    setOpenedAs(snapshotEditor(next));
  }

  function confirmDraftSwitch() {
    if (pendingEditor !== null) applyEditor(pendingEditor);
  }

  function cancelDraftSwitch() {
    setPendingEditor(null);
  }

  function cancelEditor() {
    if (formPending) return;
    setEditing(null);
    setOpenedAs({ kind: "none" });
    setPendingEditor(null);
    setFormError(null);
  }

  function requestDelete(item: Item) {
    setDeleteError(null);
    setDeleteTarget(item);
  }

  function cancelDelete() {
    setDeleteTarget(null);
    setDeleteError(null);
  }

  async function remove(id: string): Promise<void> {
    setDeletePending(true);
    setDeleteError(null);
    try {
      const result = await sendJson<{ error?: string }>(config.endpoint, { method: "DELETE", body: { id } }, config.describeError);
      if (!result.ok) {
        setDeleteError(result.message);
        return;
      }
      setRows((prev) => prev.filter((row) => accessors.id(row) !== id));
      onWrite?.();
      setDeleteTarget(null);
      if (closesOnDelete(editing, id)) {
        setEditing(null);
        setOpenedAs({ kind: "none" });
        setFormError(null);
      }
    } finally {
      setDeletePending(false);
    }
  }

  async function move(from: number, to: number): Promise<void> {
    const rowPayload = config.rowPayload;
    if (!rowPayload || from === to || reorderPending) return;
    const before = rows;
    const after = reorderRows(before, from, to, accessors);
    const changed = changedOrderRows(before, after, accessors);
    if (changed.length === 0) return;

    setRows(after);
    onWrite?.();
    setReorderPending(true);
    setListError(null);
    const outcome = await writeBackReorder(config, changed, rowPayload);
    if (!outcome.ok) {
      // The store, not `before`, is the source of truth for what landed:
      // rows written before the failure keep their new order there. Show
      // the store's list when it can be read, the pre-move list when it
      // cannot, and the reorder's own error either way.
      if (outcome.fresh.ok) {
        setRows(outcome.fresh.rows);
        setCategories(outcome.fresh.categories);
      } else {
        setRows(before);
      }
      setListError(outcome.message);
    }
    setReorderPending(false);
  }

  return {
    rows,
    setRows,
    categories,
    setCategories,
    listError,
    loaded,
    reload,
    nextOrder: nextOrderOf(rows, accessors),
    editing,
    setEditing,
    openEditor,
    pendingEditor,
    confirmDraftSwitch,
    cancelDraftSwitch,
    formPending,
    formError,
    cancelEditor,
    submitEditor,
    deleteTarget,
    deletePending,
    deleteError,
    requestDelete,
    cancelDelete,
    remove,
    reorderPending,
    move,
  };
}
