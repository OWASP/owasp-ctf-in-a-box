import type { OutboxEntry } from "./store";

export type OrderedOutboxEntry = { id: string; entry: OutboxEntry };

/** Deterministic delivery order, oldest first. Entries written by the same
 *  lifecycle CAS share one `at` timestamp, so `ord` (their position in that
 *  CAS) breaks the tie and keeps "launch" ahead of the "pause" that followed
 *  it. An entry with no `ord` (a standalone enqueue) is 0; entries that tie
 *  on both keys keep their input order. */
export function compareOutboxOrder(a: OrderedOutboxEntry, b: OrderedOutboxEntry): number {
  const byAt = Date.parse(a.entry.at) - Date.parse(b.entry.at);
  if (byAt !== 0) return byAt;
  return (a.entry.ord ?? 0) - (b.entry.ord ?? 0);
}
