import type { OutboxEntry } from "./store";

export type OrderedOutboxEntry = { id: string; entry: OutboxEntry };

/** Deterministic delivery order, oldest first. Entries carrying the Redis
 *  outbox sequence (`seq`, stamped by the write script) are ordered by it:
 *  that is the COMMITTED order, so a pause cannot sort after the resume that
 *  follows it just because one replica's clock ran ahead — `at` alone can
 *  only order writers, not writes. Entries written by the same lifecycle CAS
 *  also share one `at`, so `ord` (their position in that CAS) breaks a seq
 *  tie and keeps "launch" ahead of the "pause" that followed it. Entries
 *  with no `seq` (written before the field existed) fall back to the
 *  `at`/`ord` order; `ord` absent is 0, and entries that tie on both keys
 *  keep their input order. */
export function compareOutboxOrder(a: OrderedOutboxEntry, b: OrderedOutboxEntry): number {
  const seqA = a.entry.seq;
  const seqB = b.entry.seq;
  if (seqA !== undefined && seqB !== undefined && seqA !== seqB) return seqA - seqB;
  const byAt = Date.parse(a.entry.at) - Date.parse(b.entry.at);
  if (byAt !== 0) return byAt;
  return (a.entry.ord ?? 0) - (b.entry.ord ?? 0);
}
