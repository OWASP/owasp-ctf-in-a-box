// Announce observation helpers (#590). Pure — no mocks.

import { describe, expect, it } from "vitest";
import {
  boardChanged,
  dailyWallDue,
  decodeBoardSnapshot,
  decodeLifecycleState,
  encodeBoardSnapshot,
  encodeLifecycleState,
  eventLocalDay,
  formatDayLabel,
  formatTimeLeft,
  isEventLocalDay,
  leaderFromBoard,
  lifecycleEdges,
  lifecycleSnapshotFrom,
  markCrossed,
  markKey,
  releaseField,
  selectReleasable,
  wallClockMinutes,
  type BoardRow,
  type LifecycleSnapshot,
  type ReleasableItem,
} from "@/lib/announce/detect";

const snap = (over: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot => ({
  launched: false,
  paused: false,
  registrationClosed: false,
  ...over,
});

describe("lifecycle pack", () => {
  it("round-trips and rejects unknown shapes", () => {
    const s = snap({ launched: true, paused: true, registrationClosed: true });
    expect(decodeLifecycleState(encodeLifecycleState(s))).toEqual(s);
    expect(decodeLifecycleState("v2|L1")).toBeNull();
    expect(decodeLifecycleState(null)).toBeNull();
  });
});

describe("lifecycleEdges", () => {
  it("announces launch once, from the pre-launch baseline", () => {
    const edges = lifecycleEdges(null, snap({ launched: true }));
    expect(edges.map((e) => e.kind)).toEqual(["launch"]);
  });

  it("never announces a phantom resume at launch (pre-launch reads paused)", () => {
    // Pre-launch: launched=false. lifecycleSnapshotFrom gives paused=false
    // pre-launch, but even a hand-built paused=true baseline must not pair
    // with launch into a resume.
    const edges = lifecycleEdges(snap({ launched: false, paused: true }), snap({ launched: true, paused: false }));
    expect(edges.map((e) => e.kind)).toEqual(["launch"]);
  });

  it("announces pause and resume edges only while live", () => {
    const live = snap({ launched: true });
    expect(lifecycleEdges(live, snap({ launched: true, paused: true })).map((e) => e.kind)).toEqual(["pause"]);
    expect(
      lifecycleEdges(snap({ launched: true, paused: true }), snap({ launched: true, paused: false })).map((e) => e.kind),
    ).toEqual(["resume"]);
  });

  it("announces registration-closed once, only once launched", () => {
    expect(lifecycleEdges(null, snap({ launched: true, registrationClosed: true })).map((e) => e.kind)).toEqual(["launch"]);
    expect(
      lifecycleEdges(snap({ launched: true }), snap({ launched: true, registrationClosed: true })).map((e) => e.kind),
    ).toEqual(["registration-closed"]);
    // Reopening is silent.
    expect(
      lifecycleEdges(snap({ launched: true, registrationClosed: true }), snap({ launched: true })).map((e) => e.kind),
    ).toEqual([]);
  });
});

describe("lifecycleSnapshotFrom", () => {
  const base = { scoringStartsAt: "2026-01-01T00:00:00Z", scoringEndsAt: "2026-01-02T00:00:00Z", paused: false, registrationOpen: true };
  const t = (s: string) => Date.parse(s);

  it("pre-launch reads launched=false, paused=false", () => {
    expect(lifecycleSnapshotFrom(base, t("2025-12-31T12:00:00Z"))).toEqual(snap());
  });

  it("live reads launched, and a passed end reads paused", () => {
    expect(lifecycleSnapshotFrom(base, t("2026-01-01T12:00:00Z"))).toEqual(snap({ launched: true }));
    expect(lifecycleSnapshotFrom(base, t("2026-01-03T00:00:00Z"))).toEqual(snap({ launched: true, paused: true }));
  });

  it("a manual pause reads paused while live", () => {
    expect(lifecycleSnapshotFrom({ ...base, paused: true }, t("2026-01-01T12:00:00Z"))).toEqual(snap({ launched: true, paused: true }));
  });
});

describe("board snapshot", () => {
  const rows: BoardRow[] = [
    { slug: "a", name: "A", points: 300 },
    { slug: "b", name: "B", points: 200 },
  ];

  it("round-trips through the compact encoding", () => {
    const decoded = decodeBoardSnapshot(encodeBoardSnapshot(rows));
    expect(decoded).toEqual([
      { slug: "a", name: "a", points: 300 },
      { slug: "b", name: "b", points: 200 },
    ]);
  });

  it("treats an empty current board as never a change", () => {
    expect(boardChanged(rows, [])).toBe(false);
    expect(boardChanged(null, [])).toBe(false);
  });

  it("treats the first non-empty board, and any rank/points move, as a change", () => {
    expect(boardChanged(null, rows)).toBe(true);
    expect(boardChanged([], rows)).toBe(true);
    expect(boardChanged(rows, [...rows].reverse())).toBe(true);
    expect(boardChanged(rows, rows)).toBe(false);
  });

  it("extracts the leader announcement payload by scope", () => {
    expect(leaderFromBoard(rows, "first")).toEqual({ leader: { name: "A", points: 300 }, runnersUp: [] });
    expect(leaderFromBoard(rows, "top3")?.runnersUp).toEqual([{ name: "B", points: 200 }]);
    expect(leaderFromBoard([], "first")).toBeNull();
  });
});

describe("daily helpers", () => {
  it("derives the event-local day, DST-inclusive, in the configured zone", () => {
    // 2026-01-14 23:30 UTC is already the 15th in Auckland (UTC+13).
    const ms = Date.parse("2026-01-14T23:30:00Z");
    expect(eventLocalDay(ms, "UTC")).toBe("2026-01-14");
    expect(eventLocalDay(ms, "Pacific/Auckland")).toBe("2026-01-15");
    expect(isEventLocalDay("2026-01-15")).toBe(true);
    expect(isEventLocalDay("nope")).toBe(false);
  });

  it("gates on the local wall clock reaching dailyAt", () => {
    const ms = Date.parse("2026-01-14T09:00:30Z");
    expect(dailyWallDue(ms, "UTC", "09:00")).toBe(true);
    expect(dailyWallDue(ms, "UTC", "09:01")).toBe(false);
    expect(dailyWallDue(ms, "UTC", "bad")).toBe(false);
    expect(wallClockMinutes(ms, "UTC")).toBe(9 * 60);
  });

  it("formats a day label and the remaining time", () => {
    expect(formatDayLabel("2026-01-14", "UTC")).toContain("Jan");
    expect(formatTimeLeft(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T01:30:00Z"))).toBe("1h 30m");
    expect(formatTimeLeft(Date.parse("2026-01-01T00:00:00Z"), null)).toBeNull();
  });
});

describe("marks", () => {
  it("keys by close instant AND mark, and bands the crossing", () => {
    const ends = Date.parse("2026-01-02T00:00:00Z");
    expect(markKey(ends, 3_600_000)).toBe(`${ends}:3600000`);
    expect(markCrossed(ends - 3_600_000, ends, 3_600_000)).toBe(true);
    expect(markCrossed(ends - 3_600_001, ends, 3_600_000)).toBe(false);
    expect(markCrossed(ends + 1, ends, 3_600_000)).toBe(false);
  });
});

describe("selectReleasable", () => {
  const item = (id: string, module: "classic" | "quiz" | "ai" = "classic"): ReleasableItem => ({
    module,
    id,
    title: id,
    category: "c",
    points: 100,
  });

  it("takes unclaimed public items and skips claimed ones", () => {
    const out = selectReleasable([item("a"), item("b")], [], new Set([releaseField("classic", "a")]));
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });

  it("skips locked story steps but keeps step 1 and non-story items", () => {
    const stories = [{ id: "s", title: "S", intro: "", steps: ["a", "b"] }];
    const out = selectReleasable([item("a"), item("b"), item("c")], stories, new Set());
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("namespaces ledger fields per module", () => {
    expect(releaseField("classic", "web-1")).toBe("classic:web-1");
    expect(releaseField("ai", "web-1")).not.toBe(releaseField("classic", "web-1"));
  });
});
