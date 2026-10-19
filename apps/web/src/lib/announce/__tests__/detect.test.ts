// Announce observation helpers (#590). Pure — no mocks.

import { describe, expect, it } from "vitest";
import {
  announcedLifecyclePause,
  challengeField,
  decodeLifecycleState,
  encodeLifecycleState,
  formatTimeLeft,
  lifecycleEdges,
  lifecycleSnapshotFrom,
  markCrossed,
  markKey,
  type LifecycleSnapshot,
} from "@/lib/announce/detect";

const snap = (over: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot => ({
  launched: false,
  paused: false,
  closed: false,
  announced: false,
  ...over,
});

/** The stored state a tick would produce: the snapshot derived from settings,
 *  with `announced` carried from the previous STORED state. */
const advance = (
  prev: LifecycleSnapshot | null,
  settings: { scoringStartsAt: string | null; scoringEndsAt: string | null; paused: boolean },
  nowMs: number,
): LifecycleSnapshot => {
  const derived = lifecycleSnapshotFrom(settings, nowMs);
  return { ...derived, announced: announcedLifecyclePause(prev, derived) };
};

describe("lifecycle pack", () => {
  it("round-trips and rejects unknown shapes", () => {
    const s = snap({ launched: true, paused: true, closed: true, announced: true });
    expect(decodeLifecycleState(encodeLifecycleState(s))).toEqual(s);
    expect(decodeLifecycleState("v2|L1")).toBeNull();
    expect(decodeLifecycleState("v2|L1P1R1A0")).toBeNull();
    // The pre-announced three-flag pack: unknown now, so it seeds silently
    // rather than being misparsed as a pause.
    expect(decodeLifecycleState("v1|L1P1C1")).toBeNull();
    expect(decodeLifecycleState("v1|L1P1")).toBeNull();
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
    expect(lifecycleEdges(live, snap({ launched: true, paused: true, announced: true })).map((e) => e.kind)).toEqual(["pause"]);
    expect(
      lifecycleEdges(snap({ launched: true, paused: true, announced: true }), snap({ launched: true, paused: false })).map((e) => e.kind),
    ).toEqual(["resume"]);
  });

  it("never announces a lone resume for a pause that was never announced", () => {
    // A pause born while closed carries `announced:false`, so lifting it —
    // even after the window reopens — must not post "Scoring resumed" with
    // no pause before it.
    expect(
      lifecycleEdges(snap({ launched: true, paused: true, announced: false }), snap({ launched: true, paused: false })).map((e) => e.kind),
    ).toEqual([]);
  });

  it("the window closing is NOT a pause, and nothing resumes out of closed", () => {
    // Live and unpaused, then the end passes: the snapshot flips to closed
    // — announcing "paused … until it resumes" here would promise a resume
    // that can never come.
    expect(lifecycleEdges(snap({ launched: true }), snap({ launched: true, closed: true })).map((e) => e.kind)).toEqual([]);
    // Live and MANUALLY paused when the end passes: still no edges — the
    // close must not read as the resume of that pause, and the paused bit is
    // preserved across the close.
    expect(
      lifecycleEdges(
        snap({ launched: true, paused: true, announced: true }),
        snap({ launched: true, paused: true, closed: true, announced: true }),
      ).map((e) => e.kind),
    ).toEqual([]);
    // An admin extending the window after the close must not announce a
    // phantom resume either.
    expect(
      lifecycleEdges(snap({ launched: true, closed: true }), snap({ launched: true })).map((e) => e.kind),
    ).toEqual([]);
  });

  it("does not re-announce a freeze when an extended window reopens while still frozen", () => {
    // freeze → window closed: the paused bit is preserved across the close,
    // so neither transition is an edge.
    const frozen = snap({ launched: true, paused: true, announced: true });
    const closed = snap({ launched: true, paused: true, closed: true, announced: true });
    expect(lifecycleEdges(frozen, closed).map((e) => e.kind)).toEqual([]);
    // window extended while STILL frozen: reopening is the same pause, so
    // the reopen must not announce it a second time.
    expect(lifecycleEdges(closed, frozen).map((e) => e.kind)).toEqual([]);
    // Unfreezing after the extension is still the one resume of that pause.
    expect(lifecycleEdges(frozen, snap({ launched: true })).map((e) => e.kind)).toEqual(["resume"]);
  });

  it("close → freeze → extend → unfreeze announces neither a pause nor a resume (#590)", () => {
    // The edge case the old `!before.closed` guard left open: the freeze
    // happens while the window is already closed, so no pause was announced
    // (next.closed suppresses it). The pause bit survives the close and the
    // extension, but because it was never announced, lifting it posts
    // nothing instead of a lone "Scoring resumed".
    const base = { scoringStartsAt: "2026-01-01T00:00:00Z", scoringEndsAt: "2026-01-02T00:00:00Z", paused: false };
    const live = advance(null, base, Date.parse("2026-01-01T12:00:00Z"));
    const closed = advance(live, base, Date.parse("2026-01-03T00:00:00Z"));
    const frozen = advance(closed, { ...base, paused: true }, Date.parse("2026-01-03T00:00:00Z"));
    const extended = advance(frozen, { ...base, paused: true }, Date.parse("2026-01-01T12:00:00Z"));
    const unfrozen = advance(extended, base, Date.parse("2026-01-01T12:00:00Z"));
    expect([closed, frozen, extended, unfrozen].map((s) => [s.paused, s.closed, s.announced])).toEqual([
      [false, true, false],
      [true, true, false],
      [true, false, false],
      [false, false, false],
    ]);
    expect(lifecycleEdges(live, closed).map((e) => e.kind)).toEqual([]);
    expect(lifecycleEdges(closed, frozen).map((e) => e.kind)).toEqual([]);
    expect(lifecycleEdges(frozen, extended).map((e) => e.kind)).toEqual([]);
    expect(lifecycleEdges(extended, unfrozen).map((e) => e.kind)).toEqual([]);
  });

  it("an announced freeze still resumes after a close and a window extension (#590)", () => {
    // The contrast case: the freeze happened while LIVE and was announced, so
    // the same close/extend/unfreeze path must still post exactly one resume.
    const base = { scoringStartsAt: "2026-01-01T00:00:00Z", scoringEndsAt: "2026-01-02T00:00:00Z", paused: false };
    const live = advance(null, base, Date.parse("2026-01-01T12:00:00Z"));
    const frozen = advance(live, { ...base, paused: true }, Date.parse("2026-01-01T12:00:00Z"));
    const closed = advance(frozen, { ...base, paused: true }, Date.parse("2026-01-03T00:00:00Z"));
    const extended = advance(closed, { ...base, paused: true }, Date.parse("2026-01-01T12:00:00Z"));
    const unfrozen = advance(extended, base, Date.parse("2026-01-01T12:00:00Z"));
    expect(lifecycleEdges(live, frozen).map((e) => e.kind)).toEqual(["pause"]);
    expect(lifecycleEdges(frozen, closed).map((e) => e.kind)).toEqual([]);
    expect(lifecycleEdges(closed, extended).map((e) => e.kind)).toEqual([]);
    expect(lifecycleEdges(extended, unfrozen).map((e) => e.kind)).toEqual(["resume"]);
  });
});

describe("lifecycleSnapshotFrom", () => {
  const base = { scoringStartsAt: "2026-01-01T00:00:00Z", scoringEndsAt: "2026-01-02T00:00:00Z", paused: false };
  const t = (s: string) => Date.parse(s);

  it("pre-launch reads launched=false, paused=false", () => {
    expect(lifecycleSnapshotFrom(base, t("2025-12-31T12:00:00Z"))).toEqual(snap());
  });

  it("live reads launched, and a passed end reads CLOSED — not paused", () => {
    expect(lifecycleSnapshotFrom(base, t("2026-01-01T12:00:00Z"))).toEqual(snap({ launched: true }));
    expect(lifecycleSnapshotFrom(base, t("2026-01-03T00:00:00Z"))).toEqual(snap({ launched: true, closed: true }));
  });

  it("a passed end preserves a manual freeze instead of dropping it (#590)", () => {
    // The real paused bit is kept across the close so a later window
    // extension cannot mistake the same freeze for a fresh one; `closed`
    // still wins for milestone gating, which checks it first.
    expect(lifecycleSnapshotFrom({ ...base, paused: true }, t("2026-01-03T00:00:00Z"))).toEqual(
      snap({ launched: true, closed: true, paused: true }),
    );
  });

  it("a manual pause reads paused while live", () => {
    expect(lifecycleSnapshotFrom({ ...base, paused: true }, t("2026-01-01T12:00:00Z"))).toEqual(snap({ launched: true, paused: true }));
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

  it("formats the remaining-time label", () => {
    expect(formatTimeLeft(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T01:30:00Z"))).toBe("1h 30m");
    expect(formatTimeLeft(Date.parse("2026-01-01T00:00:00Z"), null)).toBeNull();
  });
});

describe("challengeField", () => {
  it("namespaces ledger fields per module", () => {
    expect(challengeField("classic", "web-1")).toBe("classic:web-1");
    expect(challengeField("ai", "web-1")).not.toBe(challengeField("classic", "web-1"));
  });
});
