// /rules on a classic-only event. Same discipline as the quiz-only sibling:
// "Submit every pull request from the account you signed in with" and a scope
// rule listing patch targets are secure-development's, not the platform's,
// and must not leak onto a classic-only page.
//
// The hint-cost rule used to be on that list and is not any more (#249):
// classic sells hints through the same gate, so stating their price here is
// this module's own copy doing its job, not a leak.
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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["classic"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["classic"] }),
}));

import Rules from "@/app/(site)/rules/page";

const html = await Rules().then(renderToStaticMarkup);

describe("/rules in a classic-only event", () => {
  it("keeps the platform-wide rules", () => {
    expect(html).toContain("Scoring is per team, and you need one before anything you solve counts.");
    expect(html).toContain("Each person belongs to at most one team at a time.");
    expect(html).toContain("OWASP Code of Conduct");
    expect(html).toContain("Be excellent to the volunteers, organizers, and your fellow competitors.");
    expect(html).toContain("Prizes are awarded to the top individuals and top teams overall.");
    expect(html).toContain("Organizer decisions on scoring disputes are final.");
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

  it("states the same rules in classic's own terms", () => {
    expect(html).toContain(
      "Your GitHub login is your identity for scoring — everything you submit counts for the account you signed in with.",
    );
    expect(html).toContain("The published flags are the whole game.");
    expect(html).toContain(
      "Submit your own work. Don&#x27;t publish flags or writeups for others to copy during the event.",
    );
    expect(html).toContain(
      "Found a bug in a flag, the scoring pipeline, or the site itself? Report it to an organizer instead of exploiting it for an unfair edge.",
    );
  });

  it("never claims an attempt cap", () => {
    expect(html).not.toMatch(/\battempts? (remaining|left)\b/i);
  });

  it("DOES tell contestants a hint costs points — classic sells them (#249)", () => {
    // This assertion used to be its exact opposite. The hint-cost rule was
    // read as secure-development's, so on a classic-only event the price of a
    // hint reached a contestant only from the reveal button itself.
    const text = normalizeHtml(html);
    expect(text).toContain("hint");
    expect(text).toContain("deducts points");
  });

  it("still renders all four sections", () => {
    for (const heading of ["Teams", "Fair play", "Conduct", "Scoring &amp; prizes"]) {
      expect(html).toContain(heading);
    }
  });
});
