// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. renderToStaticMarkup (ships with react-dom) is
// enough to check the initial server render, since we only assert on markup
// text — same pattern as quiz/__tests__/page.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { isModuleEnabled, isAdminLogin, getSession, listChallenges, listCategories, getSolveCounts, getViewerClassic, getAdminSettings, getResolvedModules, deriveStatusSpy } =
  vi.hoisted(() => ({
    isModuleEnabled: vi.fn(),
    isAdminLogin: vi.fn(),
    getSession: vi.fn(),
    listChallenges: vi.fn(),
    listCategories: vi.fn(),
    getSolveCounts: vi.fn(),
    getViewerClassic: vi.fn(),
    getAdminSettings: vi.fn(),
    getResolvedModules: vi.fn(),
    deriveStatusSpy: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
// ChallengeBoard (the client component this page renders) calls useRouter for
// its post-submit refresh — needs a mock the same way quiz-board.test.tsx
// mocks it, since real next/navigation needs a router context.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/modules", () => ({ isModuleEnabled }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/classic-store", () => ({
  listChallenges,
  listCategories,
  getSolveCounts,
  getViewerClassic,
  CLASSIC_COOLDOWN_SEC: 5,
}));
// Wraps (not replaces) the real deriveStatus, so every existing assertion on
// rendered markup still exercises the real per-viewer status logic — only
// the Finding-A cooldown-fallback test below inspects what `cooldownMs` this
// wrapper was actually called with, since the board's markup doesn't render
// cooldown state any differently from unsolved.
vi.mock("@/lib/derive-status", async (orig) => {
  const actual = await orig<typeof import("@/lib/derive-status")>();
  deriveStatusSpy.mockImplementation(actual.deriveStatus);
  return { deriveStatus: deriveStatusSpy };
});

import FlagsPage, { generateMetadata } from "@/app/(site)/flags/page";

const baseChallenges = [
  { id: "c1", title: "Solved one", category: "Web", description: "d1", points: 10, order: 0 },
  { id: "c2", title: "Still cooling down", category: "Web", description: "d2", points: 20, order: 1 },
  { id: "c3", title: "Never attempted", category: "Crypto", description: "d3", points: 30, order: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  isAdminLogin.mockReturnValue(false);
  // Registry-default fallback, same shape resolveModules would produce for an
  // event with only the classic module enabled and no organizer overrides.
  // Tests that care about an organizer-renamed title override this per-case.
  getResolvedModules.mockResolvedValue([
    { id: "classic", title: "Jeopardy", blurb: "Find the flag, submit the string, take the points." },
  ]);
  listCategories.mockResolvedValue(["Web", "Crypto"]);
  getSolveCounts.mockResolvedValue(new Map());
});

describe("flags page gate", () => {
  it("404s when the classic module is not enabled", async () => {
    isModuleEnabled.mockReturnValue(false);
    await expect(FlagsPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("flags page view model", () => {
  it("derives solved/cooldown/unsolved per challenge from viewer progress and settings", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listChallenges.mockResolvedValue(baseChallenges);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: 300 });
    getViewerClassic.mockResolvedValue({
      solved: { c1: { points: 10, at: "2026-08-18T00:00:00.000Z" } },
      attempts: {
        c2: { attempts: 1, lastAt: new Date().toISOString() }, // fresh — inside the 300s cooldown
      },
    });

    const html = renderToStaticMarkup(await FlagsPage());

    // The grid shows STATE, not forms (issue #208): the solved tile is
    // marked, every tile links to its own page, and the description/form
    // moved there.
    expect(html).toContain("(solved)");
    expect(html).toContain('href="/flags/c1"');
    expect(html).toContain('href="/flags/c2"');
    expect(html).toContain('href="/flags/c3"');
    expect(html).not.toMatch(/submit flag/i);
    expect(html).not.toContain("d1"); // descriptions live on /flags/[id]
    expect(html).toContain("/ 3 solved");
  });

  // The page and <ChallengeBoard> each used to print their own count ("You've
  // solved 1 of 3 challenges." above "1 / 3 solved"), which reads as a
  // rendering bug. One statement of progress, from one place — the grid's
  // summary strip.
  it("states progress exactly once", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listChallenges.mockResolvedValue(baseChallenges);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });
    getViewerClassic.mockResolvedValue({
      solved: { c1: { points: 10, at: "2026-08-18T00:00:00.000Z" } },
      attempts: {},
    });

    const html = renderToStaticMarkup(await FlagsPage());

    // The rail owns the count; the page-level sentence must not return.
    expect(html).not.toMatch(/You&#x27;ve solved/);
    expect(html.match(/\/ 3 solved/g)).toEqual(["/ 3 solved"]);
  });

  it("treats a signed-out visitor as having no progress and prompts sign-in instead of a submit control", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listChallenges.mockResolvedValue([baseChallenges[2]]);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });

    const html = renderToStaticMarkup(await FlagsPage());

    expect(getViewerClassic).not.toHaveBeenCalled();
    expect(html).toMatch(/sign in with github/i);
    expect(html).not.toContain("<button");
    // And no personal summary — nothing personal to summarize.
    expect(html).not.toContain("/ 1 solved");
  });

  it("shows an empty state with no challenges available", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listChallenges.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });

    const html = renderToStaticMarkup(await FlagsPage());
    expect(html).toMatch(/no challenges are available/i);
  });

  // The state every new event starts in, and the first thing an organizer
  // sees after provisioning. A contestant's "check back soon" is a correct
  // dead end for them and a useless one for whoever has to author the board.
  it("routes an organizer to the authoring tab from the empty state", async () => {
    isModuleEnabled.mockReturnValue(true);
    isAdminLogin.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listChallenges.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });
    getViewerClassic.mockResolvedValue({ solved: {}, attempts: {} });

    const html = renderToStaticMarkup(await FlagsPage());

    expect(html).toContain('href="/admin?tab=classic"');
    expect(html).toMatch(/author challenges/i);
    expect(html).not.toMatch(/check back soon/i);
  });

  it("shows a signed-in contestant the plain empty state, with no admin link", async () => {
    isModuleEnabled.mockReturnValue(true);
    isAdminLogin.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { login: "bob" } });
    listChallenges.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });
    getViewerClassic.mockResolvedValue({ solved: {}, attempts: {} });

    const html = renderToStaticMarkup(await FlagsPage());

    expect(html).toMatch(/check back soon/i);
    expect(html).not.toContain("/admin");
  });

  it("renders the organizer's module title instead of the default", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listChallenges.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });
    getResolvedModules.mockResolvedValue([{ id: "classic", title: "Flag Hunt", blurb: "Ten flags." }]);

    const html = renderToStaticMarkup(await FlagsPage());
    expect(html).toContain("Flag Hunt");
  });

  // The progress line and the sign-in prompt must both render even when the
  // event has zero challenges — a real regression this kit has shipped by
  // nesting them inside the populated branch.
  it("still prompts a signed-out visitor to sign in when there are no challenges at all", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listChallenges.mockResolvedValue([]);
    getAdminSettings.mockResolvedValue({ classicCooldownSec: null });

    const html = renderToStaticMarkup(await FlagsPage());

    // Non-vacuity: this really is the empty-state render, not a populated one.
    expect(html).toMatch(/no challenges are available/i);
    expect(html).toMatch(/sign in with github to submit flags/i);
  });

  // Finding A: getAdminSettings() must fail OPEN at the page level, same
  // doctrine ai-store.ts's resolveSettings applies to this exact read (its
  // /ai counterpart mirrors this test) — a Redis blip on the settings read
  // must not take the whole public board down, only fall the cooldown back
  // to the module default.
  it("still renders the board when the settings read rejects, falling the cooldown back to the module default", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listChallenges.mockResolvedValue(baseChallenges);
    getAdminSettings.mockRejectedValue(new Error("ECONNRESET"));
    getViewerClassic.mockResolvedValue({ solved: {}, attempts: {} });

    const html = renderToStaticMarkup(await FlagsPage());

    // The board itself rendered — challenges are visible, not an error page.
    expect(html).toContain('href="/flags/c1"');
    expect(html).toContain('href="/flags/c2"');
    expect(html).toContain('href="/flags/c3"');
    // The cooldown fed to every per-challenge status derivation is the
    // module default (CLASSIC_COOLDOWN_SEC, mocked to 5 above) in
    // milliseconds — never NaN/0 from a blind `settings.classicCooldownSec`
    // read off a `null` settings object, which is what an unguarded
    // `settings.classicCooldownSec` would do once `settings` itself is `null`.
    expect(deriveStatusSpy).toHaveBeenCalled();
    for (const call of deriveStatusSpy.mock.calls) {
      expect(call[2]).toBe(5000);
    }
  });
});

describe("flags page metadata", () => {
  it("falls back to the registry default title/description when there's no organizer override", async () => {
    getResolvedModules.mockResolvedValue([
      { id: "classic", title: "Jeopardy", blurb: "Find the flag, submit the string, take the points." },
    ]);

    await expect(generateMetadata()).resolves.toEqual({
      title: "Jeopardy",
      description: "Find the flag, submit the string, take the points.",
    });
  });

  it("uses the organizer's resolved title/blurb when set", async () => {
    getResolvedModules.mockResolvedValue([{ id: "classic", title: "Flag Hunt", blurb: "Ten flags." }]);

    await expect(generateMetadata()).resolves.toEqual({
      title: "Flag Hunt",
      description: "Ten flags.",
    });
  });
});
