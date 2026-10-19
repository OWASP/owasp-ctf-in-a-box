// Announce observation helpers (#590). Pure — no mocks.

import { describe, expect, it } from "vitest";
import {
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
  ...over,
});

describe("lifecycle pack", () => {
  it("round-trips and rejects unknown shapes", () => {
    const s = snap({ launched: true, paused: true, closed: true });
    expect(decodeLifecycleState(encodeLifecycleState(s))).toEqual(s);
    expect(decodeLifecycleState("v2|L1")).toBeNull();
    expect(decodeLifecycleState("v1|L1P1R1")).toBeNull();
    // The pre-close two-flag pack: unknown now, so it seeds silently rather
    // than being misparsed as a pause.
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
    expect(lifecycleEdges(live, snap({ launched: true, paused: true })).map((e) => e.kind)).toEqual(["pause"]);
    expect(
      lifecycleEdges(snap({ launched: true, paused: true }), snap({ launched: true, paused: false })).map((e) => e.kind),
    ).toEqual(["resume"]);
  });

  it("the window closing is NOT a pause, and nothing resumes out of closed", () => {
    // Live and unpaused, then the end passes: the snapshot flips to closed
    // — announcing "paused … until it resumes" here would promise a resume
    // that can never come.
    expect(lifecycleEdges(snap({ launched: true }), snap({ launched: true, closed: true })).map((e) => e.kind)).toEqual([]);
    // Live and MANUALLY paused when the end passes: still no edges — the
    // close must not read as the resume of that pause.
    expect(
      lifecycleEdges(snap({ launched: true, paused: true }), snap({ launched: true, closed: true })).map((e) => e.kind),
    ).toEqual([]);
    // An admin extending the window after the close must not announce a
    // phantom resume either.
    expect(
      lifecycleEdges(snap({ launched: true, closed: true }), snap({ launched: true })).map((e) => e.kind),
    ).toEqual([]);
  });

  it("does not re-announce a freeze when an extended window reopens while still frozen", () => {
    // freeze → window closed: the snapshot drops `paused` for `closed`, and
    // neither transition is an edge.
    const frozen = snap({ launched: true, paused: true });
    const closed = snap({ launched: true, closed: true });
    expect(lifecycleEdges(frozen, closed).map((e) => e.kind)).toEqual([]);
    // window extended while STILL frozen: reopening is the same pause, so
    // the reopen must not announce it a second time.
    expect(lifecycleEdges(closed, frozen).map((e) => e.kind)).toEqual([]);
    // Unfreezing after the extension is still the one resume of that pause.
    expect(lifecycleEdges(frozen, snap({ launched: true })).map((e) => e.kind)).toEqual(["resume"]);
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

  it("a passed end wins over a manual freeze, like scoringClosure judges it", () => {
    expect(lifecycleSnapshotFrom({ ...base, paused: true }, t("2026-01-03T00:00:00Z"))).toEqual(
      snap({ launched: true, closed: true }),
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
