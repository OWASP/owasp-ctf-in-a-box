// Delivery ordering (#590): compareOutboxOrder is the single sort key both
// the sweep and the delivery loop use, and the claim script's earlier-edge
// check mirrors it. Entries stamped with the Redis outbox sequence sort by
// it — the committed order — while entries written before that field
// existed keep the (at, ord) order they were delivered under. The mocked
// suites cannot see this: only a comparison unit can pin the tie rules.

import { describe, expect, it } from "vitest";
import { compareOutboxOrder, type OrderedOutboxEntry } from "@/lib/announce/order";
import type { OutboxEntry } from "@/lib/announce/store";

function item(id: string, fields: Partial<OutboxEntry>): OrderedOutboxEntry {
  return {
    id,
    entry: {
      kind: "first-blood",
      payload: {},
      at: "2026-11-17T12:00:00.000Z",
      n: 0,
      status: "pending",
      webhookGeneration: 1,
      kindEpoch: 0,
      ...fields,
    },
  };
}

const sort = (entries: OrderedOutboxEntry[]) => [...entries].sort(compareOutboxOrder).map((e) => e.id);

describe("compareOutboxOrder", () => {
  it("sorts by seq when both entries carry one — a writer's clock cannot reorder commits", () => {
    // The resume committed first (seq 1) but its replica's clock ran ahead
    // of the pause that followed it (seq 2): `at` alone would deliver the
    // pause first and strand it behind a resume still in flight.
    const entries = [
      item("pause", { kind: "pause", seq: 2, at: "2026-11-17T12:00:00.000Z" }),
      item("resume", { kind: "resume", seq: 1, at: "2026-11-17T12:00:10.000Z" }),
    ];
    expect(sort(entries)).toEqual(["resume", "pause"]);
  });

  it("breaks a seq tie with at, then with ord — the same-CAS order that put launch before its pause", () => {
    const sameSeqAt = [
      item("b", { seq: 3, at: "2026-11-17T12:00:00.000Z" }),
      item("a", { seq: 3, at: "2026-11-17T11:59:59.000Z" }),
    ];
    expect(sort(sameSeqAt)).toEqual(["a", "b"]);

    const sameAt = [
      item("pause", { kind: "pause", seq: 3, at: "2026-11-17T12:00:00.000Z", ord: 1 }),
      item("launch", { kind: "launch", seq: 3, at: "2026-11-17T12:00:00.000Z", ord: 0 }),
    ];
    expect(sort(sameAt)).toEqual(["launch", "pause"]);
  });

  it("keeps the legacy (at, ord) order for entries written before seq existed", () => {
    const legacy = [
      item("later", { at: "2026-11-17T12:00:00.000Z" }),
      item("earlier", { at: "2026-11-17T11:00:00.000Z" }),
      item("tie-ord-1", { at: "2026-11-17T12:00:00.000Z", ord: 1 }),
    ];
    expect(sort(legacy)).toEqual(["earlier", "later", "tie-ord-1"]);

    const legacySameAt = [
      item("second", { at: "2026-11-17T12:00:00.000Z", ord: 1 }),
      item("first", { at: "2026-11-17T12:00:00.000Z", ord: 0 }),
    ];
    expect(sort(legacySameAt)).toEqual(["first", "second"]);
  });

  it("falls back to (at, ord) when only one side carries a seq — mixed fleets stay deterministic", () => {
    const mixed = [
      item("stamped", { seq: 9, at: "2026-11-17T12:00:00.000Z" }),
      item("legacy", { at: "2026-11-17T11:00:00.000Z" }),
    ];
    expect(sort(mixed)).toEqual(["legacy", "stamped"]);
  });

  it("keeps input order on a full tie (equal seq, at and ord)", () => {
    const tied = [
      item("a", { seq: 1, at: "2026-11-17T12:00:00.000Z", ord: 0 }),
      item("b", { seq: 1, at: "2026-11-17T12:00:00.000Z", ord: 0 }),
    ];
    expect(sort(tied)).toEqual(["a", "b"]);
    expect(sort([...tied].reverse())).toEqual(["b", "a"]);
  });
});
