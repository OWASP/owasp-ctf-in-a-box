// phase.ts is the pure phase-resolution logic split out of phase-line.tsx
// so a Client Component (the admin Overview screen) can recompute it from
// settings already held in memory, with no admin-store import. Direct unit
// coverage here, on top of phase-line.test.tsx's coverage of the same
// branches through resolvePhase()/PhaseLine — this pins the module in
// isolation so it stays importable from client code.
import { describe, expect, it } from "vitest";
import { phaseBoundaryLabel, phaseFromSettings } from "@/components/phase";

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("phaseFromSettings", () => {
  // #464: no scoring start = not launched — the pre-launch lobby, not live.
  it("is registration on a dateless, unpaused event (not launched)", () => {
    expect(phaseFromSettings({ paused: false, scoringStartsAt: null, scoringEndsAt: null }).phase).toBe("registration");
  });

  it("is registration when the scoring start is unparseable (not launched)", () => {
    expect(phaseFromSettings({ paused: false, scoringStartsAt: "nope", scoringEndsAt: null }).phase).toBe("registration");
  });

  it("is live once the scoring start has passed", () => {
    expect(phaseFromSettings({ paused: false, scoringStartsAt: iso(-HOUR), scoringEndsAt: null }).phase).toBe("live");
  });

  it("is registration before the scoring open", () => {
    expect(
      phaseFromSettings({ paused: false, scoringStartsAt: iso(HOUR), scoringEndsAt: null }).phase,
    ).toBe("registration");
  });

  it("is results after the scoring close, even while paused", () => {
    expect(
      phaseFromSettings({ paused: true, scoringStartsAt: iso(-2 * HOUR), scoringEndsAt: iso(-HOUR) }).phase,
    ).toBe("results");
  });

  // #464: an event that never launched has no results to show, whatever its
  // end date says — the lobby, not "See the final standings".
  it("is registration, not results, when there is no start even if the end has passed", () => {
    expect(
      phaseFromSettings({ paused: false, scoringStartsAt: null, scoringEndsAt: iso(-HOUR) }).phase,
    ).toBe("registration");
    expect(
      phaseFromSettings({ paused: true, scoringStartsAt: "nope", scoringEndsAt: iso(-HOUR) }).phase,
    ).toBe("registration");
  });

  it("is frozen under a manual pause mid-event", () => {
    expect(phaseFromSettings({ paused: true, scoringStartsAt: iso(-HOUR), scoringEndsAt: null }).phase).toBe("frozen");
  });

  it("accepts an explicit `now` so a caller can recompute after a settings change without re-reading the clock", () => {
    const settings = { paused: false, scoringStartsAt: iso(HOUR), scoringEndsAt: null };
    expect(phaseFromSettings(settings, Date.now()).phase).toBe("registration");
    expect(phaseFromSettings(settings, Date.now() + 2 * HOUR).phase).toBe("live");
  });
});

describe("phaseBoundaryLabel", () => {
  it("promises nothing during a manual freeze", () => {
    expect(phaseBoundaryLabel("frozen", null, iso(HOUR))).toBeNull();
  });

  it("states the close time while live", () => {
    expect(phaseBoundaryLabel("live", null, "2099-08-24T18:00:00.000Z")).toMatch(/^until Aug 24, 6:00 PM UTC$/);
  });
});
