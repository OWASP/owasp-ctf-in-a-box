// THE regression this whole task exists for: an event that runs only the quiz
// must not describe a game it isn't running. The failure mode is silent — a
// quiz-only landing page telling contestants to fork a repo and open a pull
// request still renders, still passes any "does it contain the event name"
// check, and only a human reading the deployed page notices. So the assertions
// that matter here are on ABSENCE.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// module set — same split as lib/__tests__/modules-resolve.test.ts.
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
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` falls back to the baked shim's ALL-module
  // `defaultModuleIds` unless this names the fixture's own set.
  // `eventIdentity` is config v2's source for the event name (issue #386,
  // PR 1b).
  getAdminSettings: async () => ({
    moduleOverrides: {},
    enabledModuleIds: ["quiz"],
    eventIdentity: { eventName: "Quiz Night" },
  }),
}));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => id === "quiz",
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

describe("landing page in a quiz-only event", () => {
  it("still renders the platform frame", () => {
    expect(html).toContain("Quiz Night");
    expect(html).toContain("How it works");
    expect(html).toContain("Run this for your own group");
  });

  it("renders no patch/PR/fork copy", () => {
    expect(html).not.toContain("pull request");
    expect(html).not.toContain("fork");
    expect(html).not.toContain("Secure Development");
    expect(html).not.toContain("Browse targets");
    // "patched" is the string that actually leaked: the platform frame's
    // progress card used to promise a "patched and non-patched count per app",
    // which a quiz-only event has no such thing as. Absence of the OTHER four
    // strings passed even while that sentence shipped, so this assertion is
    // the one carrying weight here.
    expect(html).not.toContain("patched");
  });

  // "writing the patch with an AI agent is the skill this event exists to
  // build" is secure-development's thesis. On a graded question set the same
  // section reads as an invitation to cheat, so it must travel with its module.
  it("does not invite contestants to bring an AI agent", () => {
    expect(html).not.toContain("Please use AI");
    expect(html).not.toContain("Bring your agent");
    expect(html).not.toContain("Secure Agent Playbook");
  });

  it("renders no targets grid", () => {
    expect(html).not.toContain("Each app is a well-known");
    expect(html).not.toContain("Juice Shop");
  });

  it("renders the quiz module's own copy instead", () => {
    expect(html).toContain("Answer security questions for points.");
    expect(html).toContain("Take the quiz");
    expect(html).toContain('href="/quiz"');
  });

  // The numbered how-to steps left the landing page for How to play; the
  // pitch renders the game card with the live question count instead.
  it("renders the game card, not the how-to steps", () => {
    expect(html).toContain("The game");
    expect(html).not.toContain("Work through the questions");
  });

  it("describes the event with the quiz tagline, not secure-development's", () => {
    expect(metadata.description).toBe("Quiz Night — Quiz.");
  });
});
