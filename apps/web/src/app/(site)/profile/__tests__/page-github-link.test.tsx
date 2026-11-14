// The profile's GitHub link block: linked / not linked / return states, SD off,
// and a Redis failure that must not 500 the page. Static render only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getSession, getUser, getLeaderboard, moduleLive, getGithubLink } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  getLeaderboard: vi.fn(),
  moduleLive: vi.fn(),
  getGithubLink: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => moduleLive(id)),
);
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/auth-client", () => ({ authClient: { linkSocial: vi.fn() } }));
vi.mock("@/lib/github-link", () => ({ getGithubLink }));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSource: async () => ({ getUser, getLeaderboard }) }));
vi.mock("@/lib/team-store", () => ({
  getViewerTeam: async () => null,
  resolveTeamMaxMembers: async () => 4,
  TEAM_MAX_MEMBERS: 4,
  TEAM_WRITES_ENABLED: false,
}));
vi.mock("@/lib/hint-store", () => ({
  getViewerHints: async () => ({ purchased: {}, spent: 0, count: 0 }),
  getHintPenalties: async () => new Map(),
  HINTS_AVAILABLE: true,
}));
vi.mock("@/lib/hint-config", () => ({ getHintPenalties: async () => new Map(), HINTS_AVAILABLE: true }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules: async () => [] }));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: vi.fn() }));

import ProfilePage from "@/app/(site)/profile/page";

const ADA_ID = "2d1a6b5e-3f4c-4e7d-a081-9cadbe1f2041";
const profile = {
  playerId: ADA_ID,
  team: null,
  teamName: null,
  points: 0,
  maxPoints: 0,
  patched: 0,
  failed: 0,
  total: 0,
  apps: [] as never[],
  updatedAt: null,
};

const render = async (sp?: Record<string, string>) =>
  renderToStaticMarkup(await ProfilePage({ searchParams: Promise.resolve(sp ?? {}) }));

const NOT_LINKED = "Secure Development is on. Your PRs won&#x27;t score until you link your GitHub account.";
const NOT_FINISHED = "Linking GitHub didn&#x27;t finish. Press Link GitHub account again.";

beforeEach(() => {
  vi.clearAllMocks();
  moduleLive.mockImplementation((id: string) => id === "secure-development");
  getSession.mockResolvedValue({ user: { id: ADA_ID, login: "ada", image: null } });
  getUser.mockResolvedValue(profile);
  getGithubLink.mockResolvedValue(null);
});

describe("profile GitHub link block", () => {
  it("shows the linked login and no banner or button", async () => {
    getGithubLink.mockResolvedValue({ login: "ada-gh", linkedAt: 1 });
    const html = await render();
    expect(getGithubLink).toHaveBeenCalledWith(ADA_ID);
    expect(html).toContain("GitHub: <bdi>@ada-gh</bdi>");
    expect(html).not.toContain("Link GitHub account");
    expect(html).not.toContain(NOT_LINKED);
  });

  it("warns and offers the button when SD is on and the player is not linked", async () => {
    const html = await render();
    expect(html).toContain(NOT_LINKED);
    expect(html).toContain("Link GitHub account");
    expect(html).not.toContain(NOT_FINISHED);
  });

  it("renders none of it, and reads no link, when Secure Development is off", async () => {
    moduleLive.mockReturnValue(false);
    const html = await render();
    expect(getGithubLink).not.toHaveBeenCalled();
    expect(html).not.toContain("Link GitHub account");
    expect(html).not.toContain("GitHub: <bdi>");
    expect(html).not.toContain(NOT_LINKED);
  });

  it("names the already-linked error", async () => {
    const html = await render({ error: "account_already_linked_to_different_user" });
    expect(html).toContain("That GitHub account is already linked to another player.");
    expect(html).toContain("Link GitHub account");
  });

  it("names the unverified-email error", async () => {
    const html = await render({ error: "unable_to_link_account" });
    expect(html).toContain(
      "Couldn&#x27;t link that GitHub account. Check that its primary email is verified on GitHub, then try again.",
    );
  });

  it("gives any other error the generic copy and never renders the raw code", async () => {
    const html = await render({ error: "<script>x</script>" });
    expect(html).toContain("Linking GitHub didn&#x27;t finish. Try again.");
    expect(html).not.toContain("<script>x");
  });

  it("does not render an inherited-property error name as copy", async () => {
    const html = await render({ error: "constructor" });
    expect(html).toContain("Linking GitHub didn&#x27;t finish. Try again.");
  });

  it("says the link did not finish when linked=github returns and nothing is recorded", async () => {
    const html = await render({ linked: "github" });
    expect(html).toContain(NOT_FINISHED);
  });

  it("does not say it did not finish once the link exists", async () => {
    getGithubLink.mockResolvedValue({ login: "ada-gh", linkedAt: 1 });
    const html = await render({ linked: "github" });
    expect(html).not.toContain(NOT_FINISHED);
    expect(html).toContain("GitHub: <bdi>@ada-gh</bdi>");
  });

  it("an error wins over the linked marker", async () => {
    const html = await render({ linked: "github", error: "unable_to_link_account" });
    expect(html).toContain("Couldn&#x27;t link that GitHub account.");
    expect(html).not.toContain(NOT_FINISHED);
  });

  it("renders the rest of the page without the block when the link read throws", async () => {
    getGithubLink.mockRejectedValue(new Error("redis down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render({ linked: "github" });
    expect(html).toContain("Agent dossier");
    expect(html).not.toContain("Link GitHub account");
    expect(html).not.toContain(NOT_LINKED);
    expect(html).not.toContain(NOT_FINISHED);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(ADA_ID);
    spy.mockRestore();
  });

  it("takes the first value of a repeated error parameter", async () => {
    const html = await render({ error: ["unable_to_link_account", "x"] as unknown as string });
    expect(html).toContain("Couldn&#x27;t link that GitHub account.");
  });
});
