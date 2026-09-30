// /terms on a quiz-only event.
//
// The worst of the six pages that were never opened for a module-only event:
// the scope section rendered "Your authorization to test covers the 0
// challenge targets only: ," — a legal scope clause that authorized nothing
// and read as broken, on the page whose whole job is telling contestants what
// they are permitted to attack.
//
// Own file for the usual `vi.mock` hoisting reason.
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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["quiz"] }),
}));

import Terms from "@/app/(site)/terms/page";

const html = await Terms().then(renderToStaticMarkup);

describe("/terms in a quiz-only event", () => {
  it("states a scope that authorizes something real", () => {
    expect(html).toContain("This event authorizes no testing of any system.");
    expect(html).toContain(
      "Explicitly out of scope: the scoring pipeline, the leaderboard, this website, the CTF Discord, and other contestants&#x27; accounts or machines.",
    );
    // The broken interpolation this suite exists for.
    expect(html).not.toContain("0 challenge targets");
    expect(html).not.toMatch(/only: ,/);
  });

  it("keeps the platform-wide terms", () => {
    expect(html).toContain("Prizes go to the top individuals and top teams overall.");
    expect(html).toContain("Organizer decisions on scoring disputes are final.");
    expect(html).toContain("General Disclaimer");
  });

  it("still renders all four sections", () => {
    for (const heading of [
      "Eligibility",
      "Scope of authorized testing",
      "Your submissions",
      "Scoring and prizes",
    ]) {
      expect(html).toContain(heading);
    }
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

  it("states the submission and scoring terms in the quiz's own words", () => {
    expect(html).toContain("You submit work by answering the published questions.");
    expect(html).toContain("Your best-ever result per question counts.");
  });
});
