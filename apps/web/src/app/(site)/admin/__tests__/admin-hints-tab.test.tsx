// The Hints destination (admin-redesign.md PR 1's Event/Hints/Admins split):
// the four hint-policy knobs, lifted out of Event. renderToStaticMarkup only,
// same as every other admin panel test here — the props are inert stubs, so
// this pins what renders and how it is wired, not the POST it dispatches.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSettings } from "@/lib/admin-store";
import { HINT_COST, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN } from "@/lib/hint-defaults";
import AdminHintsTab from "@/app/(site)/admin/admin-hints-tab";

const settings: AdminSettings = {
  paused: false,
  teamRegistrationOpen: true,
  hintsEnabled: null,
  hintCost: null,
  hintsMinSolves: null,
  hintsUnlockAfterMin: null,
  quizMaxAttempts: null,
  quizRetryAfterMin: null,
  classicCooldownSec: null,
  aiCooldownSec: null,
  teamMaxMembers: null,
  scoreCooldownMin: null,
  scoringStartsAt: null,
  scoringEndsAt: null,
  registrationStartsAt: null,
  registrationEndsAt: null,
  updatedBy: null,
  updatedAt: null,
  moduleOverrides: {},
  enabledModuleIds: null,
  eventIdentity: {},
  secureDevTargets: null,
};

function render(overrides: Partial<AdminSettings> = {}, inputs = { cost: "", minSolves: "", unlockAfter: "" }) {
  return renderToStaticMarkup(
    <AdminHintsTab
      settings={{ ...settings, ...overrides }}
      pending={false}
      applyField={async () => true}
      statusOf={() => ({ state: "idle" })}
      commitNumber={() => {}}
      hintCostInput={inputs.cost}
      setHintCostInput={() => {}}
      minSolvesInput={inputs.minSolves}
      setMinSolvesInput={() => {}}
      unlockAfterInput={inputs.unlockAfter}
      setUnlockAfterInput={() => {}}
    />,
  );
}

describe("AdminHintsTab", () => {
  it("renders all four hint knobs and names the modules the policy reaches", () => {
    const html = render();
    expect(html).toContain("Hints enabled");
    expect(html).toContain("Hint cost");
    expect(html).toContain("Hints: solves required");
    expect(html).toContain("Hints: unlock after (min)");
    expect(html).toMatch(/Jeopardy and AI sell their hints/);
    // Secure Development is named as having NONE, not as a seller: nothing in
    // the kit authors hint text for a target (issue #334), and the old copy
    // sent organizers to a tab with no hint field.
    expect(html).toMatch(/Secure Development have no hints/);
    // and the removed wording must not come back alongside it — the positive
    // assertion alone would pass with both sentences on the panel.
    expect(html).not.toMatch(/Secure Development, Jeopardy and AI/);
    expect(html).not.toMatch(/Each module.s own tab holds the hint text/);
  });

  it("advertises each numeric knob's server-side default as its placeholder", () => {
    const html = render();
    for (const def of [HINT_COST, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN]) {
      expect(html).toContain(`placeholder="${def}"`);
    }
  });

  it("shows the hints-enabled toggle on by default and off once turned off", () => {
    expect(render()).toMatch(/Hints enabled[\s\S]*?checked=""/);
    expect(render({ hintsEnabled: false })).not.toMatch(/Hints enabled[\s\S]*?checked=""/);
  });

  it("points the unlock-after help at the Event tab now that Schedule lives on a different destination", () => {
    const html = render();
    expect(html).toContain("on the Event tab");
    expect(html).not.toContain("a scoring start below");
    expect(html).not.toContain("in Schedule, above");
  });
});
