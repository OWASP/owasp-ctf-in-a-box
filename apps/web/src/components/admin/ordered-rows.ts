// The ordered-list arithmetic the module admin panels (quiz, classic)
// share. Every panel holds a list of admin rows whose public half carries an
// `id` and an `order`; the quiz's live at `row.question`, classic's
// at `row.challenge`. That accessor difference is the ONLY thing that
// separated three copies of sort/upsert/next-position and two copies of the
// drag/keyboard reorder, so it is expressed once here as a small accessors
// triple each panel defines for its row type.
//
// Everything here is pure, and exported, because it is the whole of the
// reordering logic: the drag handlers and the Move up/down buttons only work
// out a pair of indices and hand them here. That split is deliberate — this
// repo has no testing-library and deliberately does not want one, so drag
// events cannot be simulated in a unit test; keeping every decision about
// what the new order values ARE inside plain functions means the untestable
// part is reduced to "which two numbers get passed in".

/** How to read a row's identity and position, and how to write a position
 *  back without mutating the row. */
export type RowAccessors<Row> = {
  id: (row: Row) => string;
  order: (row: Row) => number;
  withOrder: (row: Row, order: number) => Row;
};

/** A sorted copy: by `order`, ties broken by id so the list is stable. */
export function sortByOrder<Row>(list: readonly Row[], rows: RowAccessors<Row>): Row[] {
  return [...list].sort((a, b) => rows.order(a) - rows.order(b) || rows.id(a).localeCompare(rows.id(b)));
}

/** Replaces the row with `row`'s id (or appends it) and re-sorts. */
export function upsertRow<Row>(list: readonly Row[], row: Row, rows: RowAccessors<Row>): Row[] {
  const id = rows.id(row);
  return sortByOrder([...list.filter((x) => rows.id(x) !== id), row], rows);
}

/** The position a brand-new row takes: one past the highest stored order,
 *  1 for an empty list. */
export function nextOrder<Row>(list: readonly Row[], rows: RowAccessors<Row>): number {
  return list.reduce((max, row) => Math.max(max, rows.order(row)), 0) + 1;
}

/** Moves the row at `from` to index `to` and rewrites EVERY row's `order`
 *  from its new position (1-based, so the list reads `#1, #2, …`).
 *
 *  Rows whose order is already correct for their new position are returned by
 *  REFERENCE, unchanged. That is what lets the caller persist only the rows
 *  that actually moved (see `changedOrderRows`) instead of re-POSTing the
 *  whole list on every nudge.
 *
 *  An out-of-range index is a no-op: a copy of the list, not a renumbering.
 *  A drag that lands nowhere must not quietly rewrite every row's order. */
export function reorderRows<Row>(list: readonly Row[], from: number, to: number, rows: RowAccessors<Row>): Row[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;

  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  return next.map((row, i) => (rows.order(row) === i + 1 ? row : rows.withOrder(row, i + 1)));
}

/** The rows whose `order` differs between two versions of the list — i.e.
 *  exactly the rows a reorder has to write back. Matched by id, never by
 *  position (position is the thing that changed). */
export function changedOrderRows<Row>(before: readonly Row[], after: readonly Row[], rows: RowAccessors<Row>): Row[] {
  const orderById = new Map(before.map((row) => [rows.id(row), rows.order(row)]));
  return after.filter((row) => orderById.get(rows.id(row)) !== rows.order(row));
}
