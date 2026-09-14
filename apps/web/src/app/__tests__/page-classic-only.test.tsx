// The landing page on a classic-only event — same regression class as
// page-quiz-only.test.tsx, for the module that shipped after it. A
// classic-only event must not advertise secure-development's fork/patch/PR
// workflow, and classic's own copy must actually render instead.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// module set — same split as lib/__tests__/modules-resolve.test.ts.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findSecureDevLeaks, normalizeHtml, SECURE_DEV_PATTERNS, SECURE_DEV_TERMS } from "../(site)/__tests__/secure-dev-terms";

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
    enabledModuleIds: ["classic"],
    eventIdentity: { eventName: "Flag Night" },
  }),
}));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => id === "classic",
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

describe("landing page in a classic-only event", () => {
  it("still renders the platform frame", () => {
    expect(html).toContain("Flag Night");
    expect(html).toContain("How it works");
    expect(html).toContain("Run this for your own group");
  });

  it("renders no patch/PR/fork copy", () => {
    expect(html).not.toContain("pull request");
    expect(html).not.toContain("fork");
    expect(html).not.toContain("Secure Development");
    expect(html).not.toContain("Browse targets");
    expect(html).not.toContain("patched");
  });

  it("does not invite contestants to bring an AI agent", () => {
    expect(html).not.toContain("Please use AI");
    expect(html).not.toContain("Bring your agent");
    expect(html).not.toContain("Secure Agent Playbook");
  });

  it("renders no targets grid", () => {
    expect(html).not.toContain("Each app is a well-known");
    expect(html).not.toContain("Juice Shop");
  });

  it("renders no secure-development copy", () => {
    expect(findSecureDevLeaks(html)).toEqual([]);
  });

  it.each(SECURE_DEV_TERMS)("does not leak %j", (term) => {
    expect(normalizeHtml(html)).not.toContain(term);
  });

  it.each(SECURE_DEV_PATTERNS)("does not leak %s", (pattern) => {
    expect(html).not.toMatch(pattern);
  });

  it("renders the classic module's own copy instead", () => {
    expect(html).toContain("Find each flag and submit it for points.");
    expect(html).toContain("Browse the flags");
    expect(html).toContain('href="/flags"');
  });

  // The numbered how-to steps left the landing page for How to play; the
  // pitch renders the game card with the live flag count instead.
  it("renders the game card, not the how-to steps", () => {
    expect(html).toContain("The game");
    expect(html).not.toContain("Pick a flag and go find it");
  });

  it("states the grading forgiveness WITH its case-sensitive exception, and never claims an attempt cap", () => {
    // The unconditional "case-insensitive" claim shipped in v0.3.0 and was
    // false the moment #194 landed per-flag case sensitivity — the lede must
    // now carry the qualifier the board's own badge enforces (issue #200 1.3).
    expect(html).toContain("unless a flag is marked case-sensitive");
    expect(html).not.toMatch(/\battempts? (remaining|left)\b/i);
  });

  it("describes the event with the classic tagline, not secure-development's", () => {
    expect(metadata.description).toBe("Flag Night — Jeopardy.");
  });
});
