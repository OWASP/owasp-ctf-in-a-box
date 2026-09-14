// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. renderToStaticMarkup (ships with react-dom) is
// enough to check the initial server render, since we only assert on markup
// text — same pattern as flags/__tests__/page.test.tsx, which this mirrors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  isModuleEnabled,
  isAdminLogin,
  getSession,
  listAiChallenges,
  listAiCategories,
  getAiSolveCounts,
  getViewerAi,
  getAdminSettings,
  getResolvedModules,
  redirectIfTeamless,
  deriveStatusSpy,
  getAiHintIds,
} = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(),
  isAdminLogin: vi.fn(),
  getSession: vi.fn(),
  listAiChallenges: vi.fn(),
  listAiCategories: vi.fn(),
  getAiSolveCounts: vi.fn(),
  getViewerAi: vi.fn(),
  getAdminSettings: vi.fn(),
  getResolvedModules: vi.fn(),
  redirectIfTeamless: vi.fn(),
  deriveStatusSpy: vi.fn(),
  getAiHintIds: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/modules", () => ({ isModuleEnabled }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/hint-store", () => ({ getAiHintIds }));
vi.mock("@/lib/require-team", () => ({ redirectIfTeamless }));
vi.mock("@/lib/ai-store", () => ({
  listAiChallenges,
  listAiCategories,
  getAiSolveCounts,
  getViewerAi,
  AI_COOLDOWN_SEC: 5,
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

import AiPage, { generateMetadata } from "@/app/(site)/ai/page";

const baseChallenges = [
  { id: "a1", title: "Solved one", category: "Prompt Injection", description: "d1", points: 10, order: 0, mode: "flag" },
  { id: "a2", title: "Still cooling down", category: "Prompt Injection", description: "d2", points: 20, order: 1, mode: "flag" },
  { id: "a3", title: "Never attempted", category: "Guardrails", description: "d3", points: 30, order: 2, mode: "event" },
];

beforeEach(() => {
  vi.clearAllMocks();
  isAdminLogin.mockReturnValue(false);
  // Registry-default fallback, same shape resolveModules would produce for an
  // event with only the ai module enabled and no organizer overrides.
  getResolvedModules.mockResolvedValue([
    {
      id: "ai",
      title: "AI",
      blurb: "Prompt-injection and guardrail challenges hosted outside the box, scored inside it.",
    },
  ]);
  listAiCategories.mockResolvedValue(["Prompt Injection", "Guardrails"]);
  getAiSolveCounts.mockResolvedValue(new Map());
  // The passing default — no organizer override, so the module default
  // (AI_COOLDOWN_SEC, mocked to 5 above) applies. The dedicated cooldown test
  // below overrides this per-case.
  getAdminSettings.mockResolvedValue({ aiCooldownSec: null });
  getAiHintIds.mockResolvedValue([]);
  // The passing default: whoever is viewing already has a team (or is signed
  // out, which the real helper lets through). The dedicated test below
  // overrides this to throw, mimicking Next's `redirect()` control flow.
  redirectIfTeamless.mockResolvedValue(undefined);
});

describe("ai page gate", () => {
  it("404s when the ai module is not enabled", async () => {
    isModuleEnabled.mockReturnValue(false);
    await expect(AiPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  // Mirrors the /ai/[id] suite's teamless test. The redirect fires BEFORE the
  // loads, so a teamless contestant is never bounced after work that gets
  // thrown away — the "no store read" half is what pins that ordering.
  it("redirects a signed-in, teamless contestant before it loads anything", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/profile;307;",
    });
    redirectIfTeamless.mockRejectedValue(redirectError);

    await expect(AiPage()).rejects.toBe(redirectError);
    expect(listAiChallenges).not.toHaveBeenCalled();
    expect(getViewerAi).not.toHaveBeenCalled();
    expect(getAiSolveCounts).not.toHaveBeenCalled();
  });
});

describe("ai page view model", () => {
  it("derives solved/cooldown/unsolved per challenge from viewer progress, in board order", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listAiChallenges.mockResolvedValue(baseChallenges);
    getViewerAi.mockResolvedValue({
      solved: { a1: { points: 10, at: "2026-08-18T00:00:00.000Z", source: "flag" } },
      attempts: {
        a2: { attempts: 1, lastAt: new Date().toISOString() }, // fresh — inside the cooldown
      },
    });

    const html = renderToStaticMarkup(await AiPage());

    // Board tiles show STATE, not the challenge form (that lives on
    // /ai/[id]): the solved tile is marked, every tile links to its own page.
    expect(html).toContain("(solved)");
    expect(html).toContain('href="/ai/a1"');
    expect(html).toContain('href="/ai/a2"');
    expect(html).toContain('href="/ai/a3"');
    expect(html).not.toContain("d1"); // descriptions live on /ai/[id]
    expect(html).toContain("/ 3 solved");

    // Row order: the tiles appear in the store's (server-sorted) order within
    // each category, which the board never re-sorts.
    const iA1 = html.indexOf("Solved one");
    const iA2 = html.indexOf("Still cooling down");
    expect(iA1).toBeGreaterThan(-1);
    expect(iA2).toBeGreaterThan(iA1);
  });

  it("treats a signed-out visitor as having no progress and prompts sign-in instead of a submit control", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listAiChallenges.mockResolvedValue([baseChallenges[2]]);

    const html = renderToStaticMarkup(await AiPage());

    expect(getViewerAi).not.toHaveBeenCalled();
    expect(html).toMatch(/sign in with github/i);
    expect(html).not.toContain("<button");
    // And no personal summary — nothing personal to summarize.
    expect(html).not.toContain("/ 1 solved");
  });

  it("shows an empty state with no challenges available", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listAiChallenges.mockResolvedValue([]);

    const html = renderToStaticMarkup(await AiPage());
    expect(html).toMatch(/no challenges are available/i);
  });

  // The state every new event starts in, and the first thing an organizer
  // sees after provisioning. The admin panel's ai tab exists now, so this
  // mirrors /flags and /quiz: the organizer gets the authoring link, aimed
  // at `/admin?tab=ai` — the tab this same PR added, so the link can no
  // longer land on the wrong panel.
  it("sends an organizer to the ai authoring tab from the empty board", async () => {
    isModuleEnabled.mockReturnValue(true);
    isAdminLogin.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listAiChallenges.mockResolvedValue([]);
    getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });

    const html = renderToStaticMarkup(await AiPage());

    expect(html).toContain("/admin?tab=ai");
    expect(html).toMatch(/author challenges/i);
    expect(html).not.toMatch(/check back soon/i);
  });

  it("shows a signed-in contestant the plain empty state, with no admin link", async () => {
    isModuleEnabled.mockReturnValue(true);
    isAdminLogin.mockReturnValue(false);
    getSession.mockResolvedValue({ user: { login: "bob" } });
    listAiChallenges.mockResolvedValue([]);
    getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });

    const html = renderToStaticMarkup(await AiPage());

    expect(html).toMatch(/check back soon/i);
    expect(html).not.toContain("/admin");
  });

  it("renders the organizer's module title instead of the default", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listAiChallenges.mockResolvedValue([]);
    getResolvedModules.mockResolvedValue([{ id: "ai", title: "Prompt Arena", blurb: "Break the bot." }]);

    const html = renderToStaticMarkup(await AiPage());
    expect(html).toContain("Prompt Arena");
  });

  it("still prompts a signed-out visitor to sign in when there are no challenges at all", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listAiChallenges.mockResolvedValue([]);

    const html = renderToStaticMarkup(await AiPage());

    // Non-vacuity: this really is the empty-state render, not a populated one.
    expect(html).toMatch(/no challenges are available/i);
    expect(html).toMatch(/sign in with github to play the challenges/i);
  });

  // Finding A: getAdminSettings() must fail OPEN at the page level, same
  // doctrine ai-store.ts's own resolveSettings applies to this exact read
  // (see its comment) — a Redis blip on the settings read must not take the
  // whole public board down, only fall the cooldown back to the module
  // default.
  it("still renders the board when the settings read rejects, falling the cooldown back to the module default", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listAiChallenges.mockResolvedValue(baseChallenges);
    getAdminSettings.mockRejectedValue(new Error("ECONNRESET"));
    getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });

    const html = renderToStaticMarkup(await AiPage());

    // The board itself rendered — challenges are visible, not an error page.
    expect(html).toContain('href="/ai/a1"');
    expect(html).toContain('href="/ai/a2"');
    expect(html).toContain('href="/ai/a3"');
    // The cooldown fed to every per-challenge status derivation is the
    // module default (AI_COOLDOWN_SEC, mocked to 5 above) in milliseconds —
    // never NaN/0 from a blind `settings.aiCooldownSec` read off a `null`
    // settings object, which is what an unguarded `settings.aiCooldownSec`
    // would do once `settings` itself is `null`.
    expect(deriveStatusSpy).toHaveBeenCalled();
    for (const call of deriveStatusSpy.mock.calls) {
      expect(call[2]).toBe(5000);
    }
  });

  // PR5 finding F5: getAiHintIds' OWN settings read (resolveHintConfig ->
  // getAdminSettings) used to run OUTSIDE its try, so the very same
  // getAdminSettings rejection this test exercises above ALSO escaped
  // getAiHintIds and rejected the whole Promise.all here — 500ing the board
  // even though the page's direct settings read is already caught (the test
  // above only ever proved that ONE catch, never this one). Every other test
  // in this file stubs getAiHintIds out entirely, which can't observe that
  // fix at all, so this test dynamically re-imports the REAL hint-store
  // (unmocked, just for this one case) — a regression that narrows its try
  // back down fails this test.
  it("still renders the board when getAdminSettings rejects everywhere, including inside getAiHintIds' own settings read", async () => {
    vi.resetModules();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");
    vi.doUnmock("@/lib/hint-store");

    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { login: "alice" } });
    listAiChallenges.mockResolvedValue(baseChallenges);
    getAdminSettings.mockRejectedValue(new Error("ECONNRESET"));
    getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });

    try {
      const { default: freshAiPage } = await import("@/app/(site)/ai/page");
      const html = renderToStaticMarkup(await freshAiPage());

      // The board itself rendered — challenges are visible, not a 500.
      expect(html).toContain('href="/ai/a1"');
      expect(html).toContain('href="/ai/a2"');
      expect(html).toContain('href="/ai/a3"');
      // getAiHintIds degraded to [] rather than rejecting: no paid-hint
      // markers, and never a thrown error.
      expect(html).not.toContain("paid hint available");
      expect(html).not.toContain("💡");
    } finally {
      // Restore the module-level stub every other test in this file relies on.
      vi.doMock("@/lib/hint-store", () => ({ getAiHintIds }));
      vi.resetModules();
    }
  });
});

// The board's 💡 marker (issue #211, mirrors classic/#190): availability is
// public and PER-CHALLENGE, drawn straight off `getAiHintIds()` — never the
// hint text itself, which stays server-side on the challenge's own page.
describe("ai page hint marker", () => {
  it("marks a tile whose id is in hintIds with the paid-hint marker", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listAiChallenges.mockResolvedValue(baseChallenges);
    getAiHintIds.mockResolvedValue(["a2"]);

    const html = renderToStaticMarkup(await AiPage());

    expect(html).toContain("paid hint available");
    expect(html).toContain("💡");
  });

  it("shows no marker when no challenge id is in hintIds", async () => {
    isModuleEnabled.mockReturnValue(true);
    getSession.mockResolvedValue(null);
    listAiChallenges.mockResolvedValue(baseChallenges);
    getAiHintIds.mockResolvedValue([]);

    const html = renderToStaticMarkup(await AiPage());

    expect(html).not.toContain("paid hint available");
    expect(html).not.toContain("💡");
  });
});

describe("ai page metadata", () => {
  it("falls back to the registry default title/description when there's no organizer override", async () => {
    getResolvedModules.mockResolvedValue([
      {
        id: "ai",
        title: "AI",
        blurb: "Prompt-injection and guardrail challenges hosted outside the box, scored inside it.",
      },
    ]);

    await expect(generateMetadata()).resolves.toEqual({
      title: "AI",
      description: "Prompt-injection and guardrail challenges hosted outside the box, scored inside it.",
    });
  });

  it("uses the organizer's resolved title/blurb when set", async () => {
    getResolvedModules.mockResolvedValue([{ id: "ai", title: "Prompt Arena", blurb: "Break the bot." }]);

    await expect(generateMetadata()).resolves.toEqual({
      title: "Prompt Arena",
      description: "Break the bot.",
    });
  });
});
