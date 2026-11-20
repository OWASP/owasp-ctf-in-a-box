"use client";

// The row list the quiz and classic admin panels share: one row per item
// with its title and a meta line, an Edit button, and a "⋯" menu holding the
// rarer actions — Move up, Move down, Delete (admin-redesign.md § Content
// screens). Before this every row carried four full-size buttons, so a
// twelve-row list showed twelve red Delete buttons and red stopped meaning
// anything (redesign § Why 7); Delete now sits in the menu in a neutral
// colour, and danger colour is reserved for the confirmation it opens.
//
// GROUPED when the panel says how (`groupOf` + `groups`): one section per
// category in the panel's category order, the way contestants see the board,
// instead of one flat list interleaved by order number (#1 Crypto, #1
// Forensics, #2 Crypto…). The order itself is still ONE global sequence —
// `onMove` still receives indices into `rows` — so Move up/down inside a group
// moves the row to its group-neighbour's global position and the panel's
// `reorderRows` does the rest; nothing here decides what the new order values
// ARE (see components/admin/ordered-rows.ts for why that split matters).
//
// Organizers drag rows to reorder; the per-row Move items are the
// keyboard-operable path, and not optional: dragging is a mouse gesture and
// cannot be the only way to reorder an organizer's own content. A panel with
// no reorder passes no `onMove` and gets neither drag nor the Move items.
//
// The collapsed list shows the public half only: what the meta line says is
// the panel's choice (`meta`), and the panels keep secrets — the correct
// choice, the flag — for the edit form, never for a list that might be on a
// projector.
//
// The menu is a native <details>, so it is keyboard-operable and its items
// stay in the static markup; choosing an item closes it.
//
// Owns exactly one piece of state, the index being dragged; everything else
// is the panel's.

import { useState, type MouseEvent, type ReactNode } from "react";

const MENU_ITEM =
  "rounded px-2 py-1.5 text-left text-sm text-zinc-200 hover:bg-white/[0.06] disabled:opacity-40 disabled:hover:bg-transparent";

/** Closes the menu an item lives in — a `<details>` does not close itself. */
function closeMenu(e: MouseEvent<HTMLButtonElement>): void {
  e.currentTarget.closest("details")?.removeAttribute("open");
}

/** The panel's rows arranged for display: one bucket per group, in the
 *  panel's group order, then any group the panel did not name, each row
 *  keeping its index into `rows`. Flat (one unnamed bucket) when the panel
 *  gave no `groupOf`. Exported for direct testing. */
export function bucketRows<Row>(
  rows: readonly Row[],
  groupOf: ((row: Row) => string) | undefined,
  groups: readonly string[] | undefined,
): { group: string | null; items: { row: Row; index: number }[] }[] {
  if (!groupOf) return [{ group: null, items: rows.map((row, index) => ({ row, index })) }];
  const buckets = new Map<string, { row: Row; index: number }[]>();
  for (const g of groups ?? []) buckets.set(g, []);
  rows.forEach((row, index) => {
    const g = groupOf(row);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push({ row, index });
  });
  return [...buckets.entries()].map(([group, items]) => ({ group, items }));
}

export default function SortableList<Row>({
  rows,
  keyOf,
  titleOf,
  meta,
  intro,
  emptyText,
  loading = false,
  reorderPending = false,
  onMove,
  onEdit,
  onDelete,
  groupOf,
  groups,
}: {
  rows: readonly Row[];
  keyOf: (row: Row) => string;
  /** The row's title — shown truncated, and named in the menu's aria-labels. */
  titleOf: (row: Row) => string;
  /** The muted second line under the title. */
  meta: (row: Row) => ReactNode;
  /** The sentence above a non-empty list ("Drag a question to reorder it…"). */
  intro?: string;
  /** What an empty list says ("No questions yet."). */
  emptyText: string;
  /** True while the first read is still in flight. An empty list and an
   *  unread one are different answers, and only one of them means the
   *  organizer's content is gone — so the not-yet-known state gets the same
   *  "Checking…" vocabulary the tab header already uses, and `emptyText` is
   *  reserved for a COMPLETED read that returned nothing (issue #331). */
  loading?: boolean;
  /** True while a reorder's writes are in flight — drag and the move items
   *  are held until it settles. */
  reorderPending?: boolean;
  /** Absent: the list cannot be reordered (no drag, no Move items). */
  onMove?: (from: number, to: number) => void;
  onEdit: (row: Row) => void;
  onDelete: (row: Row) => void;
  /** Group rows under headings, in `groups` order — the category list. */
  groupOf?: (row: Row) => string;
  groups?: readonly string[];
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-muted">{loading ? "Checking…" : emptyText}</p>;
  }

  const buckets = bucketRows(rows, groupOf, groups);
  const canMove = onMove !== undefined;

  return (
    <>
      {intro && canMove && <p className="text-sm text-muted">{intro}</p>}
      {buckets.map(({ group, items }) => (
        <section key={group ?? "__all"} className="flex flex-col gap-2">
          {group !== null && (
            <h4 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
              {group}
              <span className="font-mono font-normal normal-case tracking-normal">{items.length}</span>
            </h4>
          )}
          {items.length === 0 ? (
            <p className="text-sm text-muted">Nothing here yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map(({ row, index }, pos) => {
                const title = titleOf(row);
                const prev = pos > 0 ? items[pos - 1].index : null;
                const next = pos < items.length - 1 ? items[pos + 1].index : null;
                return (
                  <li
                    key={keyOf(row)}
                    draggable={canMove && !reorderPending}
                    onDragStart={canMove ? () => setDragIndex(index) : undefined}
                    onDragOver={canMove ? (e) => e.preventDefault() : undefined}
                    onDrop={
                      canMove
                        ? (e) => {
                            e.preventDefault();
                            if (dragIndex !== null && dragIndex !== index) onMove(dragIndex, index);
                            setDragIndex(null);
                          }
                        : undefined
                    }
                    onDragEnd={canMove ? () => setDragIndex(null) : undefined}
                    className="flex flex-col gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {canMove && (
                          <span aria-hidden="true" className="flex-none cursor-grab text-muted">
                            ⠿
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm text-white">{title}</p>
                          {/* The position is rendered HERE, from where the row
                              actually sits in what the reader is looking at,
                              rather than by each panel from the stored `order`
                              field. On a board seeded per category that field
                              repeats — four rows read #1 — and it is not a
                              position in any list on screen (audit F16). */}
                          <p className="text-sm text-muted">
                            <span className="tabular-nums">#{pos + 1}</span> · {meta(row)}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-none items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit(row)}
                          className="rounded-md border border-white/10 px-2.5 py-1 text-sm text-zinc-300 hover:bg-white/[0.04]"
                        >
                          Edit
                        </button>
                        <details className="relative">
                          <summary
                            aria-label={`More actions for "${title}"`}
                            className="cursor-pointer list-none rounded-md border border-white/10 px-2.5 py-1 text-sm leading-5 text-zinc-300 hover:bg-white/[0.04] [&::-webkit-details-marker]:hidden"
                          >
                            <span aria-hidden="true">⋯</span>
                          </summary>
                          <div
                            role="group"
                            aria-label={`Actions for "${title}"`}
                            className="absolute right-0 z-20 mt-1 flex w-40 flex-col rounded-md border border-white/10 bg-[#16162a] p-1 shadow-lg"
                          >
                            {canMove && (
                              <>
                                <button
                                  type="button"
                                  aria-label={`Move "${title}" up`}
                                  disabled={reorderPending || prev === null}
                                  onClick={(e) => {
                                    closeMenu(e);
                                    if (prev !== null) onMove(index, prev);
                                  }}
                                  className={MENU_ITEM}
                                >
                                  Move up
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Move "${title}" down`}
                                  disabled={reorderPending || next === null}
                                  onClick={(e) => {
                                    closeMenu(e);
                                    if (next !== null) onMove(index, next);
                                  }}
                                  className={MENU_ITEM}
                                >
                                  Move down
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                closeMenu(e);
                                onDelete(row);
                              }}
                              className={MENU_ITEM}
                            >
                              Delete
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}
