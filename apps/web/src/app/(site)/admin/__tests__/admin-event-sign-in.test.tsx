// @vitest-environment happy-dom
// The Event tab's Sign-in section: one switch per provider whose keys are in
// .env, each writing its own settings field.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AdminSettings } from "@/lib/admin-store";
import AdminEventTab, { type AdminEventTabProps } from "@/app/(site)/admin/admin-event-tab";

const settings = {
  paused: false,
  teamRegistrationOpen: true,
  displayQr: true,
  signInProviders: { github: true, google: true, discord: false },
  moduleOverrides: {},
  enabledModuleIds: null,
  eventIdentity: {},
  secureDevTargets: null,
  sponsorLogoSize: null,
} as unknown as AdminSettings;

const noop = async () => {};
const props = (over: Partial<AdminEventTabProps>): AdminEventTabProps => ({
  settings,
  pending: false,
  resetInfo: null,
  eventName: "Fixture CTF",
  configuredSignInProviders: ["google"],
  applyField: vi.fn(async () => true),
  statusOf: () => ({ state: "idle" }) as ReturnType<AdminEventTabProps["statusOf"]>,
  setConfirm: () => {},
  doReset: noop,
  doSeed: noop,
  doClearDemo: noop,
  doDeleteAllAccounts: noop,
  teamMaxMembersInput: "",
  setTeamMaxMembersInput: () => {},
  commitNumber: (async () => true) as unknown as AdminEventTabProps["commitNumber"],
  moduleChoices: [],
  liveModuleIds: [],
  nowMs: Date.parse("2026-10-10T12:00:00Z"),
  ...over,
});

afterEach(cleanup);

describe("AdminEventTab Sign-in section", () => {
  it("renders one switch for the one configured provider and writes its field", () => {
    const applyField = vi.fn(async () => true);
    const { container } = render(<AdminEventTab {...props({ applyField })} />);
    expect(container.querySelectorAll('input[id^="event-sign-in-"]')).toHaveLength(1);
    const sw = screen.getByRole("switch", { name: /Google sign-in/ });
    expect(sw.id).toBe("event-sign-in-google");
    fireEvent.click(sw);
    expect(applyField).toHaveBeenCalledWith("signInGoogle", { signInGoogle: false }, "Google sign-in");
    expect(container.textContent).toContain(
      "Username and password is always on. A provider appears here once its client id and secret are in .env and the app has restarted.",
    );
  });

  it("says so when no provider is configured", () => {
    const { container } = render(<AdminEventTab {...props({ configuredSignInProviders: [] })} />);
    expect(container.querySelectorAll('input[id^="event-sign-in-"]')).toHaveLength(0);
    expect(container.textContent).toContain(
      "No sign-in providers are configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or DISCORD_ or GITHUB_) to .env and restart.",
    );
  });

  it("explains that GitHub linking survives the switch when Secure Development is live", () => {
    const line = "Players can still link GitHub from their profile for Secure Development while this is off.";
    const on = render(<AdminEventTab {...props({ configuredSignInProviders: ["github"], liveModuleIds: ["secure-development"] })} />);
    expect(on.container.textContent).toContain(line);
    cleanup();
    const off = render(<AdminEventTab {...props({ configuredSignInProviders: ["github"] })} />);
    expect(off.container.textContent).not.toContain(line);
  });
});
