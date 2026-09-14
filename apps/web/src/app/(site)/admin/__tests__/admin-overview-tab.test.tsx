// The Overview screen. renderToStaticMarkup only (no testing-library in this
// repo, by choice), so these assert the initial view: the phase readout and
// switches (driven entirely by props), the Sync line and Modules summary
// (also prop-driven, no fetch involved), and the "Loading…" state Recent
// activity shows before its mount-time fetch could ever resolve in a static
// render. `moduleSummary` is exercised directly, same as
// admin-module-setup.tsx's setupStepStatus/setupCountLabel it's built on.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSettings } from "@/lib/admin-store";
import type { ResolvedModule } from "@/lib/modules";
import AdminOverviewTab, { moduleSummary } from "@/app/(site)/admin/admin-overview-tab";

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
  sponsorLogoSize: null,
};

const modules: readonly ResolvedModule[] = [{ id: "quiz", title: "Quiz", blurb: "b", targets: [] } as never];

function render(overrides: Partial<Parameters<typeof AdminOverviewTab>[0]> = {}) {
  return renderToStaticMarkup(
    <AdminOverviewTab
      settings={settings}
      pending={false}
      applyField={async () => true}
      statusOf={() => ({ state: "idle" })}
      setConfirm={() => {}}
      nowMs={Date.now()}
      sync={null}
      modules={modules}
      setups={{}}
      inventory={{}}
      onNavigate={() => {}}
      {...overrides}
    />,
  );
}

describe("AdminOverviewTab", () => {
  it("shows the current phase and both switches as real switches", () => {
    const html = render();
    expect(html).toContain(">live<");
    expect(html).toMatch(/role="switch"/g);
    expect(html.match(/role="switch"/g)?.length).toBe(2);
    // Not paused, registration open — both switches read "on".
    expect(html).toMatch(/aria-checked="true"[^>]*checked=""/);
  });

  it("reflects a manual freeze on the Scoring switch", () => {
    const html = render({ settings: { ...settings, paused: true } });
    expect(html).toContain(">frozen<");
    // The Scoring switch's aria-checked is `!paused` — off while frozen.
    expect(html).toMatch(/Scoring[\s\S]*?aria-checked="false"/);
  });

  // The sync poller exists for Secure Development and nothing else, so these
  // cases hand the screen an event that serves it (audit F27).
  const withSecureDev = [
    { id: "secure-development", title: "Secure Development", blurb: "b", targets: [] },
    ...modules,
  ] as readonly ResolvedModule[];

  it("shows the sync line from the prop it was handed, no fetch involved", () => {
    const html = render({
      modules: withSecureDev,
      sync: { lastPollAt: "2026-08-24T18:00:00.000Z", ingested: 5, dropped: 1, paused: false } as never,
    });
    expect(html).toMatch(/ingested 5/);
    expect(html).toMatch(/dropped 1/);
  });

  it("says sync is not running when there is no poller, and what that costs", () => {
    const html = render({ modules: withSecureDev });
    expect(html).toContain("Sync not running");
    expect(html).toMatch(/Secure Development scores are not being ingested/);
  });

  it("has no Sync section at all on an event without Secure Development", () => {
    // "Sync not running." was the first line of the admin page on a quiz-only
    // event, forever, and read as a broken box: there is no poller because
    // there are no forks to poll, which is not a fault to report (audit F27).
    const html = render();
    expect(html).not.toContain("Sync");
    // Non-vacuity: the screen did render, and the module it DOES serve is on it.
    expect(html).toContain("Quiz");
  });

  it("shows Loading… for the activity preview before its fetch could resolve", () => {
    expect(render()).toContain("Loading…");
  });

  it("lists every module with a Content link", () => {
    const html = render();
    expect(html).toContain("Quiz");
  });
});

describe("moduleSummary", () => {
  const setup = {
    experience: "",
    steps: [
      { title: "Author a question", where: "panel", check: { count: "items", noun: "questions" } },
    ],
    midEvent: { safe: [], unsafe: [] },
    docs: { href: "#", label: "" },
  } as never;

  it("says 'enabled' for a module the registry gave no setup block", () => {
    expect(moduleSummary(undefined, undefined)).toBe("enabled");
  });

  it("says 'enabled' — no verdict — for a module whose steps are all uncountable provisioning", () => {
    const provisioningOnly = { ...(setup as object), steps: [{ title: "Provision the org", where: "outside" }] } as never;
    expect(moduleSummary(provisioningOnly, undefined)).toBe("enabled");
  });

  it("says setup incomplete with no count while nothing has been authored", () => {
    expect(moduleSummary(setup, { items: 0 })).toBe("setup incomplete");
  });

  it("says checking… — not incomplete — before the module's panel has reported its counts", () => {
    expect(moduleSummary(setup, undefined)).toBe("checking…");
    expect(moduleSummary(setup, {})).toBe("checking…");
  });

  it("says setup complete with the live count once something exists", () => {
    expect(moduleSummary(setup, { items: 12 })).toBe("setup complete · 12 questions");
  });
});
