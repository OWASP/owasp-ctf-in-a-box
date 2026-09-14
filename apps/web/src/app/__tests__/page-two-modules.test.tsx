// Composition with more than one module enabled. Own file because `vi.mock`
// hoists per file and this fixture needs its own module set — see
// page-quiz-only.test.tsx and lib/__tests__/modules-resolve.test.ts.
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
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// An organizer rename, so the per-module section headings are demonstrably the
// RESOLVED title and not the registry default.
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` falls back to the baked shim's ALL-module
  // `defaultModuleIds` unless this names the fixture's own set.
  // `eventIdentity` is config v2's source for the event name (issue #386,
  // PR 1b).
  getAdminSettings: async () => ({
    moduleOverrides: { quiz: { title: "Round 1" } },
    enabledModuleIds: ["secure-development", "quiz"],
    eventIdentity: { eventName: "Two-Track CTF" },
    // The live target list comes from here, not the (now-dead) event.yaml
    // bake (issue #386, PR 2) — one target.
    secureDevTargets: ["dvwa"],
  }),
}));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => ["secure-development", "quiz"].includes(id),
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
import { generateMetadata } from "@/app/layout";

const html = await Home().then(renderToStaticMarkup);
const metadata = await generateMetadata();

describe("landing page with two modules enabled", () => {
  it("joins both taglines under the event name", () => {
    expect(html).toContain("Secure Development · Quiz");
  });

  it("renders both modules' hero intros", () => {
    expect(html).toContain("Break real vulnerabilities in 1 deliberately vulnerable training app");
    expect(html).toContain("Answer security questions for points.");
  });

  // Three stacked anonymous paragraphs read as one essay that keeps changing
  // subject (issue #200, tier 4) — each hero lede now carries its module's
  // RESOLVED title, so the label sits before its paragraph and before the
  // full sections further down.
  it("labels each hero lede with its module's resolved title", () => {
    const heroLabel = html.indexOf("Round 1");
    expect(heroLabel).toBeGreaterThan(-1);
    expect(heroLabel).toBeLessThan(html.indexOf("Answer security questions for points."));
  });

  it("renders both modules' game-card CTAs in registry order", () => {
    expect(html).toContain("Browse targets");
    expect(html).toContain("Take the quiz");
    // In ORDER — registry order also picks `firstBoard` for the hero CTA,
    // so this is a contract, not cosmetics.
    expect(html.indexOf("Browse targets")).toBeLessThan(html.indexOf("Take the quiz"));
    expect(html.indexOf("Browse targets")).toBeLessThan(html.indexOf("Take the quiz"));
  });

  it("heads each what-to-expect section with that module's resolved title", () => {
    expect(html).toContain(">Secure Development<");
    expect(html).toContain(">Round 1<");
    expect(html).not.toContain("What to expect");
  });

  // The numbered steps left the landing page for How to play; each module's
  // card carries its pitch and its door instead.
  it("renders each module's game card, not its steps", () => {
    expect(html).toContain("The games");
    expect(html).not.toContain("Patch it and open a PR");
    expect(html).not.toContain("Get scored on submit");
  });

  it("keeps the bring-your-agent section attached to secure-development only", () => {
    expect(html).toContain("Please use AI");
    // lastIndexOf: the hero now labels each module's lede with its title
    // (issue #200, tier 4), so the FIRST "Round 1" is the hero label near the
    // top. The section this ordering guards against is the LAST occurrence.
    expect(html.indexOf("Please use AI")).toBeLessThan(html.lastIndexOf("Round 1"));
  });

  it("still renders the secure-development targets grid", () => {
    expect(html).toContain("1 real target");
    expect(html).toContain("DVWA");
  });

  it("describes the event with both taglines", () => {
    expect(metadata.description).toBe("Two-Track CTF — Secure Development · Quiz.");
  });
});
