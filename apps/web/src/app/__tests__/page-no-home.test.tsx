// A module with no landing-page copy is VALID, not an error: `home` is
// optional on ModuleDef, so a future module can ship a route before it ships
// hero copy.
//
// Such a module still gets a landing section, led by its organizer-editable
// `blurb` — the one sentence every module has. It used to be dropped from the
// page entirely, which meant a module could be enabled, named and described in
// /admin and still be invisible to a contestant reading the landing page.
// Everything with no fallback (the uppercase tagline, the hero paragraph, the
// numbered steps, the CTA) stays absent rather than being invented.
//
// The fixture inverts the usual mock direction: the module set enables the
// quiz, but `getModuleHome` is stubbed to return nothing, so this exercises
// "enabled module, no home block" rather than "no modules at all". Own file
// because `vi.mock` hoists per file.
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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  // `eventIdentity` is config v2's source for the event name (issue #386,
  // PR 1b).
  getAdminSettings: async () => ({
    moduleOverrides: {},
    enabledModuleIds: ["quiz"],
    eventIdentity: { eventName: "Bare CTF" },
  }),
}));
// Real getResolvedModules (the module is genuinely enabled and resolvable);
// only the home lookup is emptied.
vi.mock("@/lib/resolved-modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resolved-modules")>()),
  getModuleHome: () => undefined,
}));
vi.mock("@/lib/challenges", () => ({ getChallengeCatalog: async () => null }));
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

import Home from "@/app/page";

const html = await Home().then(renderToStaticMarkup);

describe("landing page with no module home blocks", () => {
  it("renders the platform frame", () => {
    expect(html).toContain("Bare CTF");
    expect(html).toContain("How it works");
    expect(html).toContain("Run this for your own group");
  });

  // Asserted on CONTENT, not on a Tailwind class: a restyle must not be able
  // to silently satisfy this. The tagline <p> is the only thing that can sit
  // between the headline and the close of its wrapper, so its absence is
  // structural rather than cosmetic.
  it("renders no tagline line, and the blurb stands in for the missing intro", () => {
    // No home block means no tagline kicker above the headline: the h1
    // follows the OWASP mark directly, with no <p> in between. Structural,
    // not a class pin — a retracked restyle must not satisfy this.
    expect(html).toMatch(/alt="OWASP"[^>]*\/?><h1/);
    expect(html).not.toMatch(/<p[^>]*>[^<]*<\/p><h1/);
    // The game card's body falls back to the module's blurb — the one
    // sentence every module has — never to authored copy it doesn't.
    expect(html).not.toContain("Answer security questions for points. Every question carries");
  });

  // The registry's `description` is the blurb's default, so with no organizer
  // override this is the quiz module's own one-liner reaching the page.
  it("leads the module's game card with its blurb", () => {
    expect(html).toContain("Answer security questions for points.");
    expect(html).toContain("The game");
    // …and NOT the authored copy, which this module deliberately has none of.
    expect(html).not.toContain("Straight questions, scored on submit");
  });

  it("renders no numbered steps — steps left the landing page entirely", () => {
    expect(html).not.toContain("Work through the questions");
  });

  it("renders no module CTA", () => {
    expect(html).not.toContain("Take the quiz");
    expect(html).not.toContain("Browse targets");
  });
});
