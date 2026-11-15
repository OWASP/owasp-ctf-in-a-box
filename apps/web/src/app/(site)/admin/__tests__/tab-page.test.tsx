// `/admin/<tab>` — the canonical, linkable form of every admin destination.
//
// Same mocks and same shape as page.test.tsx (the `?tab=` entry), because the
// point of these cases is that the two routes are the SAME panel: one gate,
// one set of reads, one fallback. A difference between them is the bug this
// file exists to catch.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { requireAdmin, getAdminSettings, getSyncStatus, getResolvedModules, getModuleSetup } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminSettings: vi.fn(),
  getSyncStatus: vi.fn(),
  getModuleSetup: vi.fn(() => undefined),
  getResolvedModules: vi.fn(async () => [
    { id: "secure-development", title: "Secure Development", blurb: "", targets: ["juice-shop"] },
    { id: "quiz", title: "Quiz", blurb: "", targets: [] },
  ]),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
// admin-panel.tsx now also reads getEnabledApps() (lib/enabled-apps.ts, issue
// #386 PR 2), whose settings snapshot goes through `@/lib/enabled-modules`'s
// `getAdminSettingsSnapshot`, which calls the real `connection()` — mocked
// here so it can run outside a request scope; `@/lib/enabled-modules` itself
// is left real so it falls through to the `getAdminSettings` mock below,
// same as page.test.tsx's copy of this comment.
vi.mock("next/server", () => ({ connection: async () => {} }));
// Same grant count as page.test.tsx, for the same reason.
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/admin-grants", () => ({ countAdminGrants: async () => 1 }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings, getSyncStatus }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules, getModuleSetup }));
// Same reason as page.test.tsx: admin-panel.tsx now reads getSite() too, and
// its real chain throws outside a Next request store (connection()).
//
// Distinct from the spec default and every fixture below, same reasoning as
// page.test.tsx — a regression that stops threading this through to
// AdminHeader would fail the assertion below rather than pass by
// coincidence.
vi.mock("@/lib/site", () => ({ getSite: async () => ({ name: "Plumbed CTF" }) }));

import AdminTabPage from "@/app/(site)/admin/[tab]/page";

const ADMIN_PLAYER = { id: "00000000-0000-4000-8000-0000000000a1", name: "alice", image: null, githubLogin: null };

// The same minimal settings shape page.test.tsx uses — `moduleOverrides` is
// not optional in practice: the module panels index into it.
const SETTINGS = {
  paused: false,
  hintsEnabled: null,
  hintCost: null,
  updatedBy: null,
  updatedAt: null,
  moduleOverrides: {},
  eventIdentity: {},
};

async function render(tab: string, query: Record<string, string | string[] | undefined> = {}): Promise<string> {
  return renderToStaticMarkup(
    await AdminTabPage({ params: Promise.resolve({ tab }), searchParams: Promise.resolve(query) }),
  );
}

function selectedTab(html: string): string | null {
  const match = html.match(/href="\/admin\/([a-z-]+)"[^>]*aria-current="page"/);
  return match ? match[1] : null;
}

function asAdmin(): void {
  requireAdmin.mockResolvedValue({ ok: true, player: ADMIN_PLAYER });
  getAdminSettings.mockResolvedValue(SETTINGS);
  getSyncStatus.mockResolvedValue(null);
}

describe("/admin/<tab>", () => {
  it("gates exactly like /admin — a non-admin gets the courteous wall, not a 404", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect(await render("overview")).toMatch(/organizer/i);
  });

  it("opens the destination the path names", async () => {
    asAdmin();
    expect(selectedTab(await render("activity"))).toBe("activity");
    expect(selectedTab(await render("insights"))).toBe("insights");
    expect(selectedTab(await render("quiz"))).toBe("quiz");
  });

  // Issue #386, same pin as page.test.tsx: the header names the RUNTIME
  // event (getSite()), not a hardcoded default — this catches admin-panel.tsx
  // reverting `<AdminHeader eventName={...}>` back to a constant, since the
  // mocked getSite() above returns a name no fixture or default shares.
  it("names the event in the header from getSite(), not the baked config", async () => {
    asAdmin();
    expect(await render("overview")).toContain("Plumbed CTF");
  });

  it("falls back to Overview for a segment this event has no tab for", async () => {
    asAdmin();
    // A stale runbook link, a typo, or a module this event never enabled —
    // all land somewhere real rather than on a 404.
    expect(selectedTab(await render("classic"))).toBe("overview");
    expect(selectedTab(await render("nonsense"))).toBe("overview");
  });

  it("honours an explicit ?tab= over the path, so one URL cannot mean two things", async () => {
    asAdmin();
    // The popstate handler resolves this URL to `hints`; the server has to
    // agree, or loading the link and navigating to it open different panels.
    expect(selectedTab(await render("overview", { tab: "hints" }))).toBe("hints");
  });

  it("treats a repeated ?tab= as absent and falls back to the path", async () => {
    asAdmin();
    // Two different answers is no answer — better the path than a guess.
    expect(selectedTab(await render("insights", { tab: ["hints", "event"] }))).toBe("insights");
  });

  it("links every destination as a path, never the old query form", async () => {
    asAdmin();
    const html = await render("overview");
    expect(html).toContain('href="/admin/hints"');
    expect(html).toContain('href="/admin/secure-development"');
    expect(html).not.toContain('href="?tab=');
  });
});
