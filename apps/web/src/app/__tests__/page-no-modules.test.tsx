// Config v2 (issue #386): zero enabled modules is now a LEGAL state — a
// fresh deployment with no scorer image, or an organizer who has switched
// every board off in /admin. The landing page must say so rather than
// rendering an empty grid that reads as a broken page.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// empty enabled set — same split as lib/__tests__/modules-resolve.test.ts
// and the sibling page-*.test.tsx files.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
// The redesigned landing reads the session (for the state-aware primary CTA),
// the viewer's team, and — once the event is past registration — the top of
// the leaderboard. These fixtures render signed-out with the board read
// failing, which the page must tolerate by hiding the strip.
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/team-store", () => ({ hasTeam: async () => false, getViewerTeam: async () => null }));
vi.mock("@/lib/leaderboard/source", () => ({
  getLeaderboardSource: async () => ({
    getLeaderboard: async () => {
      throw new Error("no leaderboard in this fixture");
    },
  }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules([]),
);
vi.mock("@/lib/admin-store", () => ({
  // Empty set on both sides: `getResolvedModules` (via this mock) and
  // `isModuleLive` (via the enabled-modules mock above, serving `[]`) must
  // agree that nothing is enabled.
  // `eventIdentity` is config v2's source for the event name (issue #386,
  // PR 1b).
  getAdminSettings: async () => ({
    moduleOverrides: {},
    enabledModuleIds: [],
    eventIdentity: { eventName: "Quiet CTF" },
  }),
}));
vi.mock("@/lib/challenges", () => ({ getChallengeCatalog: async () => null }));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "" });
  return { Poppins: font, Barlow: font, Geist_Mono: font };
});
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

import Home from "@/app/page";

const html = await Home().then(renderToStaticMarkup);

describe("landing page with no enabled modules", () => {
  it("still renders the platform frame", () => {
    expect(html).toContain("Quiet CTF");
    expect(html).toContain("How it works");
    expect(html).toContain("Run this for your own group");
  });

  it("renders the no-boards empty state instead of a game card", () => {
    expect(html).toContain("No boards are open yet.");
    expect(html).toContain("An organizer switches them on in the admin panel.");
  });

  it("renders no module game card copy", () => {
    expect(html).not.toContain("Answer security questions for points.");
    expect(html).not.toContain("Take the quiz");
    expect(html).not.toContain("Browse targets");
    expect(html).not.toContain("Each app is a well-known");
  });

  it("titles the section for the plural, empty case", () => {
    expect(html).toContain("The games");
    expect(html).not.toContain("The game<");
  });
});
