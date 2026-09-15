// The reorder math behind the sponsor list's up/down arrows. A pure function
// in sponsors-keys.ts rather than logic inside the tab component, because the
// tab's state lives behind a `useEffect` fetch that never runs under
// `renderToStaticMarkup` — this is the half worth pinning directly.

import { describe, expect, it } from "vitest";
import {
  asSponsorLogoMime,
  movedSponsorOrder,
  nextSponsorOrder,
  SPONSOR_LOGO_MIME_TYPES,
} from "@/lib/sponsors-keys";

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

// The logo MIME allowlist the admin dialog pre-checks against. The SERVER
// ignores a claimed type entirely (sponsors-store.ts sniffs the decoded
// bytes), so this is not a security control on what gets stored — it is what
// keeps a browser-supplied string from reaching the dialog's preview URL, and
// what turns an obvious SVG into an explanation instead of a round trip.
describe("asSponsorLogoMime", () => {
  it("accepts the three raster types the store can store", () => {
    expect(asSponsorLogoMime("image/png")).toBe("image/png");
    expect(asSponsorLogoMime("image/jpeg")).toBe("image/jpeg");
    expect(asSponsorLogoMime("image/webp")).toBe("image/webp");
  });

  it("rejects SVG, an unknown type, and a missing one", () => {
    expect(asSponsorLogoMime("image/svg+xml")).toBeNull();
    expect(asSponsorLogoMime("text/html")).toBeNull();
    expect(asSponsorLogoMime("")).toBeNull();
    expect(asSponsorLogoMime(undefined)).toBeNull();
  });

  // The point of returning the constant rather than the argument: whatever a
  // caller passes, what comes back is one of three literals from this module.
  it("returns its own constant, not the caller's string", () => {
    const claimed = ["image", "/png"].join("");
    const matched = asSponsorLogoMime(claimed);
    expect(matched).toBe("image/png");
    expect(SPONSOR_LOGO_MIME_TYPES).toContain(matched);
  });
});

// Where a newly added sponsor lands. The tab used to pass `rows.length`, which
// is only correct while stored orders are dense — and they are not: a delete
// leaves a gap until the next reorder renumbers, and an imported archive
// carries whatever numbers it was exported with. A new sponsor filed into the
// middle of the list is the visible symptom.
describe("nextSponsorOrder", () => {
  it("is one past the highest stored order, not the row count", () => {
    expect(nextSponsorOrder([{ order: 0 }, { order: 5 }, { order: 9 }])).toBe(10);
  });

  it("starts at 0 for an empty list", () => {
    expect(nextSponsorOrder([])).toBe(0);
  });

  it("does not care what order the rows are given in", () => {
    expect(nextSponsorOrder([{ order: 7 }, { order: 1 }])).toBe(8);
  });

  // Seeded at -1, so an all-negative list yields 0 rather than a negative
  // number. 0 still sorts after every row here, which is the actual
  // requirement — "last", not "exactly one more than the maximum".
  it("never goes negative, and still lands last", () => {
    expect(nextSponsorOrder([{ order: -4 }, { order: -2 }])).toBe(0);
  });

  // A stored hash can hold anything; a NaN must not swallow the maximum and
  // hand every later sponsor the same order.
  it("ignores a non-finite order rather than propagating it", () => {
    expect(nextSponsorOrder([{ order: 3 }, { order: Number.NaN }])).toBe(4);
  });
});
