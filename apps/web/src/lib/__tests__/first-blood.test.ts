// #188: who drew first blood on a challenge, read off the solve rows. The
// order is the leaderboard's "whoever got there first" reasoning (rank.ts's
// activity tiebreak): earliest solve time wins, a row with no parseable time
// sorts after every row with one. Where the leaderboard falls back to source
// order, first blood cannot (source order here is SCAN order), so the last
// key is the login, compared case-insensitively.
import { describe, expect, it } from "vitest";

import { compareFirstBlood, earlierFirstBlood, type FirstBlood } from "@/lib/first-blood";

const at = (login: string, iso: string | null): FirstBlood => ({ login, at: iso });

describe("compareFirstBlood", () => {
  it("puts the earlier solve first", () => {
    const early = at("zed", "2026-10-01T12:00:00.000Z");
    const late = at("amy", "2026-10-01T12:00:00.001Z");
    expect(compareFirstBlood(early, late)).toBeLessThan(0);
    expect(compareFirstBlood(late, early)).toBeGreaterThan(0);
  });

  it("compares instants, not strings (an offset spelling of an earlier time still wins)", () => {
    // 13:00+02:00 is 11:00Z: earlier, though it sorts later as a string.
    const offset = at("zed", "2026-10-01T13:00:00.000+02:00");
    const utc = at("amy", "2026-10-01T12:00:00.000Z");
    expect(compareFirstBlood(offset, utc)).toBeLessThan(0);
  });

  it("sorts a row with no parseable time after every row with one", () => {
    const timed = at("zed", "2026-10-01T12:00:00.000Z");
    expect(compareFirstBlood(at("amy", null), timed)).toBeGreaterThan(0);
    expect(compareFirstBlood(at("amy", "not a time"), timed)).toBeGreaterThan(0);
  });

  it("breaks an exact tie by login, case-insensitively, whatever the input order", () => {
    const t = "2026-10-01T12:00:00.000Z";
    expect(compareFirstBlood(at("bob", t), at("Alice", t))).toBeGreaterThan(0);
    expect(compareFirstBlood(at("Alice", t), at("bob", t))).toBeLessThan(0);
    // Two untimed rows tie the same way.
    expect(compareFirstBlood(at("bob", null), at("alice", null))).toBeGreaterThan(0);
  });
});

describe("earlierFirstBlood", () => {
  it("keeps the earliest across any arrival order", () => {
    const rows = [
      at("carol", "2026-10-01T12:00:02.000Z"),
      at("bob", "2026-10-01T12:00:01.000Z"),
      at("Alice", "2026-10-01T12:00:01.000Z"),
      at("dave", null),
    ];
    for (const order of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
      expect(order.reduce<FirstBlood | undefined>(earlierFirstBlood, undefined)).toEqual(at("Alice", "2026-10-01T12:00:01.000Z"));
    }
  });
});
