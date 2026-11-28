// @vitest-environment happy-dom
// The Hints tab's board-size warning, wired through AdminControls: the
// Jeopardy panel reports its inventory after it mounts (an effect, which a
// static render never runs), and the shell passes its `onBoard` count to the
// Hints tab only while Jeopardy is enabled.
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { AdminSettings } from "@/lib/admin-store";
import type { ResolvedModule } from "@/lib/modules";

vi.mock("@/lib/modules", () => ({
  enabledModules: [],
  ALL_MODULE_IDS: ["secure-development", "quiz", "classic"],
  moduleDefById: (id: string) =>
    ({
      "secure-development": { displayName: "Secure Development", description: "" },
      quiz: { displayName: "Quiz", description: "" },
      classic: { displayName: "Jeopardy", description: "" },
    })[id],
  MODULE_TITLE_MAX: 60,
  MODULE_BLURB_MAX: 200,
}));

// A Jeopardy panel that reports three challenges, one of them listed and live,
// once mounted, as the real one does after its lists load.
vi.mock("@/components/admin-classic-controls", () => ({
  default: function ReportingClassicPanel({
    onInventory,
  }: {
    onInventory?: (inventory: { items: number; categories: number; unlisted: number; onBoard: number }) => void;
  }) {
    useEffect(() => {
      onInventory?.({ items: 3, categories: 1, unlisted: 0, onBoard: 1 });
    }, [onInventory]);
    return null;
  },
}));

// The tabs that load their own data on mount are not under test here.
for (const path of [
  "@/app/(site)/admin/admin-overview-tab",
  "@/app/(site)/admin/admin-admins-tab",
  "@/app/(site)/admin/admin-activity-tab",
  "@/app/(site)/admin/admin-insights-tab",
  "@/app/(site)/admin/admin-support-tab",
  "@/app/(site)/admin/admin-sponsors-tab",
  "@/components/admin-quiz-controls",
]) {
  vi.doMock(path, () => ({ default: () => null }));
}

const modules: readonly ResolvedModule[] = [
  { id: "quiz", title: "Quiz", blurb: "" },
  { id: "classic", title: "Jeopardy", blurb: "" },
];

const settings = {
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
  scoringStartsAt: "2000-01-01T00:00:00.000Z",
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
} as unknown as AdminSettings;

async function hintsPanel(enabledModuleIds: NonNullable<AdminSettings["enabledModuleIds"]>) {
  const { default: AdminControls } = await import("@/app/(site)/admin/admin-controls");
  const { container } = render(
    <AdminControls
      viewerId="organizer"
      eventName="Fixture CTF"
      defaultModuleIds={["quiz"]}
      secureDevAvailable
      initial={{ ...settings, enabledModuleIds }}
      modules={modules}
    />,
  );
  const panel = container.querySelector("#panel-hints");
  if (!panel) throw new Error("no Hints panel");
  return panel;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminControls → Hints board-size warning", () => {
  it("shows the warning for a one-challenge board while Jeopardy is enabled", async () => {
    const panel = await hintsPanel(["quiz", "classic"]);

    // "solves required" is at its default of 1, so one challenge on the board is too few.
    expect(panel.textContent).toContain("The Jeopardy board has 1 challenge");
    expect(panel.querySelector('[role="status"]')).not.toBeNull();
  });

  it("does not pass the count to the Hints tab while Jeopardy is off", async () => {
    // The Jeopardy panel still mounts and reports, since its tab stays reachable.
    const panel = await hintsPanel(["quiz"]);

    expect(panel.textContent).not.toContain("The Jeopardy board has");
  });
});
