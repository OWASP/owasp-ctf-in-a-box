// #592: the projector board's QR code is switched in /admin → Event, on by
// default. Static render: the switch's state comes from the settings.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { AdminSettings } from "@/lib/admin-store";
import AdminEventTab, { type AdminEventTabProps } from "@/app/(site)/admin/admin-event-tab";

const settings: AdminSettings = {
  paused: false,
  teamRegistrationOpen: true,
  displayQr: true,
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

const noop = async () => {};
const props = (s: AdminSettings): AdminEventTabProps => ({
  settings: s,
  pending: false,
  resetInfo: null,
  eventName: "Fixture CTF",
  applyField: async () => true,
  statusOf: () => ({ state: "idle" }) as ReturnType<AdminEventTabProps["statusOf"]>,
  setConfirm: () => {},
  doReset: noop,
  doSeed: noop,
  doClearDemo: noop,
  teamMaxMembersInput: "",
  setTeamMaxMembersInput: () => {},
  commitNumber: (async () => true) as unknown as AdminEventTabProps["commitNumber"],
  moduleChoices: [],
  liveModuleIds: [],
  nowMs: Date.parse("2026-10-10T12:00:00Z"),
});

/** The QR switch's <input>, by its id. */
const qrInput = (html: string) => html.match(/<input[^>]*id="event-display-qr"[^>]*>/)?.[0] ?? "";

describe("AdminEventTab — projector QR code", () => {
  it("offers the switch, on when the setting is on", () => {
    const html = renderToStaticMarkup(<AdminEventTab {...props(settings)} />);
    expect(html).toContain("QR code on the projector board");
    expect(qrInput(html)).toMatch(/checked=""/);
  });

  it("shows it off once an organizer turned it off", () => {
    const html = renderToStaticMarkup(<AdminEventTab {...props({ ...settings, displayQr: false })} />);
    expect(qrInput(html)).not.toBe("");
    expect(qrInput(html)).not.toMatch(/checked=""/);
  });
});

describe("AdminEventTab — master reset copy", () => {
  // The reset watermark skips every score comment from before the reset, and
  // the scorer refuses them (ADR 67): ingested scores do not come back on the
  // unfreeze. Only a PR scored again after the reset counts.
  it("says pre-reset PR scores stay gone and only a re-scored PR counts", () => {
    const html = renderToStaticMarkup(<AdminEventTab {...props(settings)} />);
    expect(html).toMatch(/scored again after the reset/i);
    expect(html).not.toMatch(/come back when you unfreeze/i);
  });
});
