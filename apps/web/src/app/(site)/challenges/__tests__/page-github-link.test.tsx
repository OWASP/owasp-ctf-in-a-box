// Fork links stay hidden until a signed-in player has linked GitHub, and a
// failed link read must not 500 the page. Static render only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const launchLock = vi.hoisted(() => ({
  redirectIfNotLaunched: vi.fn(async () => ({ allowed: true, preview: false })),
}));
vi.mock("@/lib/launch", () => launchLock);

const { getSession, getGithubLink, getGithubOrg, getEnabledApps, getEnabledTotals } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getGithubLink: vi.fn(),
  getGithubOrg: vi.fn(),
  getEnabledApps: vi.fn(),
  getEnabledTotals: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/bootstrap-env", () => ({ getGithubOrg }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { linkSocial: vi.fn(), useSession: () => ({ data: null, isPending: false }) },
}));
vi.mock("@/lib/github-link", () => ({ getGithubLink }));
// Records the props the page hands the real button, which still renders.
const buttonProps = vi.hoisted(() => [] as { callbackURL?: string }[]);
vi.mock("@/components/link-github-button", async (orig) => {
  const mod = await orig<typeof import("@/components/link-github-button")>();
  return {
    ...mod,
    default: (props: { callbackURL?: string }) => {
      buttonProps.push(props);
      return mod.default(props);
    },
  };
});
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(() => true),
);
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules: async () => [] }));
vi.mock("@/lib/enabled-apps", () => ({ getEnabledApps, getEnabledTotals }));
vi.mock("@/lib/challenges", () => ({ getChallengeCatalog: async () => null }));
vi.mock("@/lib/leaderboard/source", () => ({
  getLeaderboardSource: async () => ({ getUser: async () => null }),
}));

import ChallengesPage from "@/app/(site)/challenges/page";
import { apps } from "@/lib/apps";

const ADA_ID = "2d1a6b5e-3f4c-4e7d-a081-9cadbe1f2041";
const FORK = "https://github.com/acceptance-org/DVWA";
const NOTICE = "Link your GitHub account to start.";

const render = async (sp?: Record<string, string>) =>
  renderToStaticMarkup(await ChallengesPage({ searchParams: Promise.resolve(sp ?? {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  buttonProps.length = 0;
  const dvwa = apps.find((a) => a.id === "dvwa")!;
  getEnabledApps.mockResolvedValue([dvwa]);
  getEnabledTotals.mockResolvedValue({ challenges: dvwa.challengeCount, maxPoints: dvwa.maxPoints });
  getGithubOrg.mockReturnValue("acceptance-org");
  getSession.mockResolvedValue({ user: { id: ADA_ID, login: "ada", image: null } });
  getGithubLink.mockResolvedValue({ login: "ada", linkedAt: 1 });
});

describe("/challenges fork links and GitHub linking", () => {
  it("linked: fork links render and no notice", async () => {
    const html = await render();
    expect(html).toContain(FORK);
    expect(html).not.toContain(NOTICE);
  });

  it("unlinked: no fork href, the notice and the Link button render", async () => {
    getGithubLink.mockResolvedValue(null);
    const html = await render();
    expect(html).not.toContain("https://github.com/");
    expect(html).toContain(NOTICE);
    expect(html).toContain("Link GitHub account");
    // A link started here returns here, marked so the page can tell an
    // unfinished link from a finished one.
    expect(buttonProps).toEqual([{ callbackURL: "/challenges?linked=github" }]);
  });

  it("unlinked: a failed link's error code shows the shared copy, never the raw code", async () => {
    getGithubLink.mockResolvedValue(null);
    const html = await render({ error: "account_already_linked_to_different_user" });
    expect(html).toContain("That GitHub account is already linked to another player.");
    const unknown = await render({ error: "<script>x</script>" });
    expect(unknown).toContain("Linking GitHub didn&#x27;t finish. Try again.");
    expect(unknown).not.toContain("<script>x");
  });

  it("unlinked: linked=github with no stored link says the link did not finish", async () => {
    getGithubLink.mockResolvedValue(null);
    expect(await render({ linked: "github" })).toContain("Press Link GitHub account again.");
  });

  it("signed out: fork links render, no notice, and the link is never read", async () => {
    getSession.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain(FORK);
    expect(html).not.toContain(NOTICE);
    expect(getGithubLink).not.toHaveBeenCalled();
  });

  it("a link read failure fails closed: no fork links, no notice, no throw, no identifiers logged", async () => {
    getGithubLink.mockRejectedValue(new Error("boom ada " + ADA_ID));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    expect(html).not.toContain("https://github.com/");
    expect(html).not.toContain(NOTICE);
    expect(html).toContain("DVWA");
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(ADA_ID);
    expect(logged).not.toContain("ada");
    spy.mockRestore();
  });
});
