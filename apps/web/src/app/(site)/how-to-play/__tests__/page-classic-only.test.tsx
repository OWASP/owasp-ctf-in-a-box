// /how-to-play on a classic-only event — same regression class as
// page-quiz-only.test.tsx: the page must not hand a contestant a guide to
// forking a target and opening a pull request when the event runs no such
// module, and classic's own guide must render in its place.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// event config — same split as the sibling quiz-only file.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  findSecureDevLeaks,
  normalizeHtml,
  SECURE_DEV_PATTERNS,
  SECURE_DEV_TERMS,
} from "../../__tests__/secure-dev-terms";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["classic"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["classic"] }),
}));

import HowToPlay, { generateMetadata } from "@/app/(site)/how-to-play/page";

const html = await HowToPlay().then(renderToStaticMarkup);
const metadata = await generateMetadata();

describe("/how-to-play in a classic-only event", () => {
  it("still renders the platform frame", () => {
    expect(html).toContain("How to Play");
    expect(html).toContain("Getting Started");
    expect(html).toContain("Read the rules");
    expect(html).toContain("View the leaderboard");
    expect(html).toContain("Stuck, or need an organizer?");
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

  it("renders classic's own guide instead", () => {
    expect(html).toContain(
      "New to the board? Here&#x27;s everything you need to go from a GitHub sign-in to your first solved flag.",
    );
    expect(html).toContain("find the flag");
    for (const title of ["Sign in with GitHub", "Open the board", "Find the flag", "Submit it and get scored"]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("Browse the flags");
    expect(html).toContain('href="/flags"');
  });

  it("states no attempt cap and describes the cooldown instead", () => {
    expect(html).toContain("There&#x27;s no cap on how many times you can try");
    expect(html).toContain("cooldown");
    expect(html).not.toMatch(/\battempts? (remaining|left)\b/i);
  });

  it("still renders the platform's good-to-know and scoring cards, in classic's terms", () => {
    expect(html).toContain("Good to know");
    expect(html).toContain("How scoring works");
    expect(html).toContain("Every flag is worth a fixed number of points");
  });

  it("has no worked example, because the classic module contributes none", () => {
    expect(html).not.toContain("Worked example");
    expect(html).not.toContain("<pre");
  });

  it("describes the page with classic's meta description", () => {
    expect(metadata.description).toBe(
      "Step-by-step guide to the flag board: sign in with GitHub, work through the flags, and get scored the instant you submit a correct one.",
    );
  });
});
