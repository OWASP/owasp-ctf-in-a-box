// The shareable join link's page (issue #45).
//
// The property that matters most is a NEGATIVE one: visiting the URL must not
// join anyone. The page is a Server Component, so a GET here is exactly what a
// link preview, a prefetch, or a crawler performs — if it joined, a captain
// pasting the link into chat would sign up whoever's client fetched it first.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getSession, lookupJoinCode, getViewerTeam, joinTeam, getAdminSettings } = vi.hoisted(() => ({
  getSession: vi.fn(),
  lookupJoinCode: vi.fn(),
  getViewerTeam: vi.fn(),
  joinTeam: vi.fn(),
  getAdminSettings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// The invite button is a Client Component using useRouter(); a static render
// has no app-router context to mount.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/team-store", () => ({
  lookupJoinCode,
  getViewerTeam,
  joinTeam,
  TEAM_WRITES_ENABLED: true,
}));
vi.mock("@/lib/admin-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-store")>()),
  getAdminSettings,
}));

import JoinPage from "@/app/(site)/join/[code]/page";

const OPEN_SETTINGS = {
  teamRegistrationOpen: true,
  registrationStartsAt: null,
  registrationEndsAt: null,
};

async function render(code: string) {
  return renderToStaticMarkup(await JoinPage({ params: Promise.resolve({ code }) }));
}

function signedIn(login: string | null) {
  getSession.mockResolvedValue(login ? { user: { login } } : null);
}

describe("/join/<code>", () => {
  it("NEVER joins on a GET", async () => {
    // The whole reason the button exists.
    signedIn("octocat");
    lookupJoinCode.mockResolvedValue({ slug: "red-team", name: "Red Team", memberCount: 2 });
    getViewerTeam.mockResolvedValue(null);
    getAdminSettings.mockResolvedValue(OPEN_SETTINGS);
    await render("ABC123");
    expect(joinTeam).not.toHaveBeenCalled();
  });

  it("names the team so the invitee knows what they are accepting", async () => {
    signedIn("octocat");
    lookupJoinCode.mockResolvedValue({ slug: "red-team", name: "Red Team", memberCount: 2 });
    getViewerTeam.mockResolvedValue(null);
    getAdminSettings.mockResolvedValue(OPEN_SETTINGS);
    const html = await render("ABC123");
    expect(html).toContain("Red Team");
    expect(html).toContain("2 players");
  });

  it("shows a friendly error for an unknown or expired code, not a crash", async () => {
    signedIn("octocat");
    lookupJoinCode.mockResolvedValue(null);
    getAdminSettings.mockResolvedValue(OPEN_SETTINGS);
    const html = await render("nope");
    expect(html).toContain("invalid or has expired");
    expect(joinTeam).not.toHaveBeenCalled();
  });

  // #499: a failed lookup is not an expired code. Telling an invitee their
  // captain's fresh link is dead sends them to ask for another one that will
  // fail the same way.
  it("says the invite could not be checked when the lookup fails, not that it expired", async () => {
    signedIn("octocat");
    lookupJoinCode.mockRejectedValue(new Error("NOAUTH"));
    getAdminSettings.mockResolvedValue(OPEN_SETTINGS);
    const html = await render("ABC123");
    expect(html).toContain("could not check this invite");
    expect(html).not.toContain("invalid or has expired");
  });

  it("offers sign-in when signed out, instead of a dead button", async () => {
    signedIn(null);
    lookupJoinCode.mockResolvedValue({ slug: "red-team", name: "Red Team", memberCount: 1 });
    getAdminSettings.mockResolvedValue(OPEN_SETTINGS);
    const html = await render("ABC123");
    expect(html).toContain("sign-in --github");
    // Still names the team: someone deciding whether to sign in should know
    // what for.
    expect(html).toContain("Red Team");
  });

  it("says registration is closed rather than offering a button that refuses", async () => {
    signedIn("octocat");
    lookupJoinCode.mockResolvedValue({ slug: "red-team", name: "Red Team", memberCount: 1 });
    getViewerTeam.mockResolvedValue(null);
    getAdminSettings.mockResolvedValue({ ...OPEN_SETTINGS, teamRegistrationOpen: false });
    const html = await render("ABC123");
    expect(html).toContain("registration is closed");
  });

  it("tells someone already on a team to leave first", async () => {
    signedIn("octocat");
    lookupJoinCode.mockResolvedValue({ slug: "red-team", name: "Red Team", memberCount: 1 });
    getViewerTeam.mockResolvedValue({ slug: "blue-team", name: "Blue Team", members: ["octocat"] });
    getAdminSettings.mockResolvedValue(OPEN_SETTINGS);
    const html = await render("ABC123");
    expect(html).toContain("already on a team");
  });

  it("degrades to open registration when the settings read fails", async () => {
    // Same fail-open reasoning as the team store: a Redis blip must not turn
    // every invite link into "registration closed".
    signedIn("octocat");
    lookupJoinCode.mockResolvedValue({ slug: "red-team", name: "Red Team", memberCount: 1 });
    getViewerTeam.mockResolvedValue(null);
    getAdminSettings.mockRejectedValue(new Error("redis down"));
    const html = await render("ABC123");
    expect(html).toContain("Join Red Team");
  });
});
