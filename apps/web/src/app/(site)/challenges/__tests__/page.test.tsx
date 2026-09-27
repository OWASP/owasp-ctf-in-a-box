// /challenges names itself from the organizer's module rename — and, with no
// rename set, from its own long-standing default.
//
// The distinction is the whole point: `secure-development`'s registry display
// name is "Secure Development", but this page has always been headed
// "Challenges". Reading the resolved `title` here would have silently retitled
// the page on every event that never opened the admin panel, the same bug the
// nav had. So both directions are pinned: override wins, no override changes
// nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
// #464 pre-launch lock: launched by default in this file; the "pre-launch
// lock" test below drives the refused path. The lock itself is unit-tested in
// lib/__tests__/launch.test.ts.
const launchLock = vi.hoisted(() => ({
  redirectIfNotLaunched: vi.fn(async () => ({ allowed: true, preview: false })),
}));
vi.mock("@/lib/launch", () => launchLock);
import { renderToStaticMarkup } from "react-dom/server";

const { getResolvedModules, getChallengeCatalog, getHintAvailability, isModuleEnabled, getEnabledApps, getEnabledTotals, getGithubOrg } = vi.hoisted(() => ({
  getResolvedModules: vi.fn(),
  getChallengeCatalog: vi.fn(),
  getHintAvailability: vi.fn(),
  isModuleEnabled: vi.fn(),
  // The live target list (issue #386, PR 2) — defaulted to the real
  // catalogue's full six in the outer beforeEach below, so every existing
  // test here keeps the behaviour it always had; only the new
  // runtime-narrowed-target-list case below overrides it.
  getEnabledApps: vi.fn(),
  getEnabledTotals: vi.fn(),
  // The org the page hands to `forkUrl` (config v2: PR 3A) — defaulted to
  // "" below so every existing test here keeps rendering plain repo-name
  // text, same as before this page read GITHUB_ORG at all; only the
  // fork-links describe block below overrides it.
  getGithubOrg: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/bootstrap-env", () => ({ getGithubOrg }));
// The page reads the session for the hint banner's sign-in clause (issue
// #200, 3.1); these tests render outside a request scope, so both the
// header store and the session read are stubbed — signed-out, matching the
// copy the assertions below were written against.
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/enabled-apps", () => ({ getEnabledApps, getEnabledTotals }));
vi.mock("@/lib/challenges", () => ({ getChallengeCatalog }));
vi.mock("@/lib/hint-store", () => ({
  getHintAvailability,
  // The page asks getHintNotice once and uses BOTH fields — hints off here,
  // so the notice must not render.
  getHintNotice: async () => ({ active: false, cost: 0 }),
}));
// Partial mock: `isModuleEnabled` is what this page's gate calls, but
// `site.ts` (imported transitively through HintNotice -> EventCountdown)
// reads `enabledModules` off this same module, so a full replacement would
// break that unrelated import instead of exercising the gate.
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled,
}));

import ChallengesPage, { generateMetadata } from "@/app/(site)/challenges/page";
import { apps } from "@/lib/apps";

const resolved = (titleOverride?: string) => [
  {
    id: "secure-development",
    nav: { href: "/challenges", label: "Challenges" },
    targets: [],
    title: titleOverride ?? "Secure Development",
    titleOverride,
    blurb: "Find the vulnerability, patch it for real, ship the fix as a PR.",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  isModuleEnabled.mockReturnValue(true);
  getChallengeCatalog.mockResolvedValue(null);
  getHintAvailability.mockResolvedValue({});
  // Default: every existing test here predates runtime target selection
  // (issue #386, PR 2) and expects the full catalogue, same as the old
  // build-time `enabledApps`.
  getEnabledApps.mockResolvedValue(apps);
  getEnabledTotals.mockResolvedValue({
    challenges: apps.reduce((sum, a) => sum + a.challengeCount, 0),
    maxPoints: apps.reduce((sum, a) => sum + a.maxPoints, 0),
  });
  // Default: no configured org, same as every test here before the page
  // read GITHUB_ORG at all — only the fork-links describe block below sets
  // this explicitly.
  getGithubOrg.mockReturnValue("");
});

describe("challenges page gate", () => {
  it("404s when secure-development is disabled", async () => {
    isModuleEnabled.mockReturnValue(false);
    await expect(ChallengesPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("/challenges with no organizer override", () => {
  beforeEach(() => getResolvedModules.mockResolvedValue(resolved()));

  it("keeps its own default page title, not the module's display name", async () => {
    expect((await generateMetadata()).title).toBe("Challenges");
  });

  it("keeps the default heading in the page body", async () => {
    const html = renderToStaticMarkup(await ChallengesPage());
    expect(html).toContain("Challenges");
    expect(html).not.toContain("Secure Development");
  });
});

describe("/challenges with an organizer override", () => {
  beforeEach(() => getResolvedModules.mockResolvedValue(resolved("Round 1")));

  it("uses the override as the metadata title", async () => {
    expect((await generateMetadata()).title).toBe("Round 1");
  });

  it("uses the override as the page heading", async () => {
    expect(renderToStaticMarkup(await ChallengesPage())).toContain("Round 1");
  });
});

// Issue #386, PR 2: which targets render is now an /admin runtime choice
// (lib/enabled-apps.ts), not a build-time fact — this is the one render-level
// proof that narrowing it actually changes what the page shows, not just
// that the plumbing type-checks.
describe("/challenges with a runtime-narrowed target list", () => {
  beforeEach(() => {
    getResolvedModules.mockResolvedValue(resolved());
    const dvwa = apps.find((a) => a.id === "dvwa")!;
    getEnabledApps.mockResolvedValue([dvwa]);
    getEnabledTotals.mockResolvedValue({ challenges: dvwa.challengeCount, maxPoints: dvwa.maxPoints });
  });

  it("renders only the admin-selected target — DVWA present, WebGoat absent", async () => {
    const html = renderToStaticMarkup(await ChallengesPage());
    expect(html).toContain("DVWA");
    expect(html).not.toContain("WebGoat");
  });

  // CodeRabbit round 1: the scorer's /challenges route returns every rubric
  // target, not the app's runtime secureDevTargets subset, so a successful
  // catalogue fetch's `total` can overcount once targets are narrowed. The
  // description must follow enabledTotals.challenges regardless of whether
  // the catalogue fetch succeeded.
  it("uses the enabled-target count for the description, not a larger catalogue total", async () => {
    const dvwa = apps.find((a) => a.id === "dvwa")!;
    getChallengeCatalog.mockResolvedValue({ byApp: {}, total: 999 });
    const html = renderToStaticMarkup(await ChallengesPage());
    expect(html).toContain(`${dvwa.challengeCount} challenges across`);
    expect(html).not.toContain("999 challenges");
  });
});

// Config v2 (PR 3A): fork links come from GITHUB_ORG (lib/bootstrap-env.ts),
// not the (now-dead) event.yaml bake. This is the page-level proof that its
// own wiring — getGithubOrg() -> forkUrl() -> the `forkUrls` prop ->
// ChallengeGrid — actually reaches the rendered markup, not just that it
// type-checks; ChallengeGrid's own unit tests cover the render logic once a
// `forkUrls` value is handed to it.
describe("/challenges wires GITHUB_ORG into the fork links", () => {
  beforeEach(() => {
    getResolvedModules.mockResolvedValue(resolved());
    const dvwa = apps.find((a) => a.id === "dvwa")!;
    getEnabledApps.mockResolvedValue([dvwa]);
    getEnabledTotals.mockResolvedValue({ challenges: dvwa.challengeCount, maxPoints: dvwa.maxPoints });
  });

  it("renders the fork link under the configured org", async () => {
    getGithubOrg.mockReturnValue("acceptance-org");
    const html = renderToStaticMarkup(await ChallengesPage());
    expect(html).toContain("https://github.com/acceptance-org/DVWA");
  });

  it("renders plain repo-name text, with no github.com link, when no org is configured", async () => {
    getGithubOrg.mockReturnValue("");
    const html = renderToStaticMarkup(await ChallengesPage());
    expect(html).toContain("DVWA");
    expect(html).not.toContain("https://github.com/");
  });
});

describe("pre-launch lock (#464)", () => {
  it("sends a refused viewer to the landing page before loading any content", async () => {
    launchLock.redirectIfNotLaunched.mockImplementationOnce(async () => {
      throw new Error("NEXT_REDIRECT:/");
    });
    await expect(ChallengesPage()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(getChallengeCatalog).not.toHaveBeenCalled();
  });
});
