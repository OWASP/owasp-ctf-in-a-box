// The Hints destination (admin-redesign.md PR 1's Event/Hints/Admins split):
// the four hint-policy knobs, lifted out of Event. renderToStaticMarkup only,
// same as every other admin panel test here — the props are inert stubs, so
// this pins what renders and how it is wired, not the POST it dispatches.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSettings } from "@/lib/admin-store";
import { HINT_COST, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN } from "@/lib/hint-defaults";
import AdminHintsTab, { hintThresholdWarning } from "@/app/(site)/admin/admin-hints-tab";

const settings: AdminSettings = {
  paused: false,
  teamRegistrationOpen: true,
  displayQr: true,
  signInProviders: { github: true },
  hintsEnabled: null,
  hintCost: null,
  hintsMinSolves: null,
  hintsUnlockAfterMin: null,
  quizMaxAttempts: null,
  quizRetryAfterMin: null,
  classicCooldownSec: null,
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
  sponsorLogoSize: null,
};

function render(
  overrides: Partial<AdminSettings> = {},
  inputs = { cost: "", minSolves: "", unlockAfter: "" },
  classicChallenges?: number,
) {
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
      classicChallenges={classicChallenges}
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
    expect(html).toMatch(/Jeopardy sells its hints/);
    // Secure Development is named as having NONE, not as a seller: nothing in
    // the kit authors hint text for a target (issue #334), and the old copy
    // sent organizers to a tab with no hint field.
    expect(html).toMatch(/Secure Development have no hints/);
    // and the removed wording must not come back alongside it — the positive
    // assertion alone would pass with both sentences on the panel.
    expect(html).not.toMatch(/Secure Development, Jeopardy/);
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


// #828: "Hints: solves required" counts a player's solves across the whole
// Jeopardy board, so a board with no more challenges than the value can never
// sell a hint for a challenge the player hasn't solved.
describe("hintThresholdWarning", () => {
  it("warns when the board has no more challenges than the solves required", () => {
    expect(hintThresholdWarning(1, 1, true)).toBe(
      'The Jeopardy board has 1 challenge, so with "solves required" at 1 nobody can buy a hint for a challenge they haven\'t solved yet: they must first solve 1 other challenge. Set it to 0 (no gate), or add challenges.',
    );
    expect(hintThresholdWarning(3, 5, true)).toMatch(/has 3 challenges, .* at 5 .*solve 5 other challenges\. Set it to 2 or lower/);
    expect(hintThresholdWarning(2, 2, true)).toMatch(/Set it to 1 or lower/);
  });

  it("says nothing when a hint can be bought, the board is unknown or empty, or the gate or hints are off", () => {
    expect(hintThresholdWarning(2, 1, true)).toBeNull();
    expect(hintThresholdWarning(undefined, 1, true)).toBeNull();
    expect(hintThresholdWarning(0, 1, true)).toBeNull();
    expect(hintThresholdWarning(1, 0, true)).toBeNull();
    expect(hintThresholdWarning(1, 1, false)).toBeNull();
  });
});

describe("AdminHintsTab threshold warning", () => {
  it("shows the warning under the field for a one-challenge board at the default", () => {
    const html = render({}, undefined, 1);
    expect(html).toContain('role="status"');
    expect(html).toContain("The Jeopardy board has 1 challenge");
  });

  it("reads the saved value, not the default, and stays quiet once the board is big enough", () => {
    expect(render({ hintsMinSolves: 3 }, undefined, 3)).toContain("at 3 nobody can buy");
    expect(render({ hintsMinSolves: 3 }, undefined, 4)).not.toContain("The Jeopardy board has");
    expect(render({}, undefined, undefined)).not.toContain("The Jeopardy board has");
    expect(render({ hintsEnabled: false }, undefined, 1)).not.toContain("The Jeopardy board has");
  });
});
