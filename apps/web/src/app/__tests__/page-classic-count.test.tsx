// The landing page's Jeopardy card counts the flags a visitor can see: a
// hidden challenge (disabled, or not yet released) does not exist for them,
// so it is not in the count either. Same fixture as page-classic-only.test.tsx,
// plus the challenge list.
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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["classic"]),
);
const launched = vi.hoisted(() => ({ startsAt: "2000-01-01T00:00:00.000Z" as string | null }));
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  // `eventIdentity` is config v2's source for the event name (issue #386,
  // PR 1b).
  getAdminSettings: async () => ({
    // A LAUNCHED event (#464): before launch the module cards carry no board
    // link. Cleared only while the dateless metadata below is computed.
    scoringStartsAt: launched.startsAt,
    moduleOverrides: {},
    enabledModuleIds: ["classic"],
    eventIdentity: { eventName: "Flag Night" },
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

vi.mock("@/lib/classic-store", () => ({
  listChallenges: async () => [{ id: "a" }, { id: "b" }, { id: "gone", enabled: false }],
}));

import Home from "@/app/page";

describe("landing page Jeopardy count", () => {
  it("counts only the visible flags", async () => {
    const html = await Home().then(renderToStaticMarkup);
    expect(html).toContain("2 flags");
    expect(html).not.toContain("3 flags");
  });
});
