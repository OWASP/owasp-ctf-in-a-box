// The reorder math behind the sponsor list's up/down arrows. A pure function
// in sponsors-keys.ts rather than logic inside the tab component, because the
// tab's state lives behind a `useEffect` fetch that never runs under
// `renderToStaticMarkup` — this is the half worth pinning directly.

import { describe, expect, it } from "vitest";
import { movedSponsorOrder } from "@/lib/sponsors-keys";

const IDS = ["a", "b", "c"];

describe("movedSponsorOrder", () => {
  it("moves a middle row up", () => {
    expect(movedSponsorOrder(IDS, "b", -1)).toEqual(["b", "a", "c"]);
  });

  it("moves a middle row down", () => {
    expect(movedSponsorOrder(IDS, "b", 1)).toEqual(["a", "c", "b"]);
  });

  // Null, not a copy: the caller skips the request entirely, so a no-op click
  // never spends a write or an audit-log line claiming a reorder happened.
  it("returns null at the top and bottom edges", () => {
    expect(movedSponsorOrder(IDS, "a", -1)).toBeNull();
    expect(movedSponsorOrder(IDS, "c", 1)).toBeNull();
  });

  it("returns null for an id that is not in the list", () => {
    expect(movedSponsorOrder(IDS, "zzz", -1)).toBeNull();
  });

  it("returns null for a single-row list in either direction", () => {
    expect(movedSponsorOrder(["only"], "only", -1)).toBeNull();
    expect(movedSponsorOrder(["only"], "only", 1)).toBeNull();
  });

  it("never mutates the array it was given", () => {
    const input = [...IDS];
    movedSponsorOrder(input, "b", 1);
    expect(input).toEqual(IDS);
  });

  it("keeps every id exactly once", () => {
    const moved = movedSponsorOrder(IDS, "c", -1)!;
    expect([...moved].sort()).toEqual([...IDS].sort());
  });
});
