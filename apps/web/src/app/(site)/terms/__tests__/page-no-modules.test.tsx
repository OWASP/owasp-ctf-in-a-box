// /terms on an event whose enabled modules contribute no terms at all — the
// case a future module ships before it has written any, and the reason each
// section has a fallback list. Without them this page renders an empty "Scope
// of authorized testing": a participation-terms page that states no scope at
// all is worse than a generic one, because that section is the one contestants
// read to find out what they are permitted to attack.
//
// A module-free config is the simplest way to reach that state (a module with
// no `terms` block behaves identically — `getModuleTerms` returns undefined
// either way). Mirrors rules/__tests__/page-no-modules.test.tsx.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findSecureDevLeaks } from "../../__tests__/secure-dev-terms";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/admin-store", () => ({
  // No `enabledModuleIds` stored: `getEnabledModuleIds` falls back to
  // `defaultModuleIds`, which is empty with no `SCORE_IMAGE` set — the
  // simplest way to reach "no module contributes any terms".
  getAdminSettings: async () => ({ moduleOverrides: {} }),
}));

import Terms from "@/app/(site)/terms/page";

const html = await Terms().then(renderToStaticMarkup);

describe("/terms with no module contributions", () => {
  it("still states a scope, an identity rule and a submission rule", () => {
    expect(html).toContain("This event authorizes no testing of any system.");
    expect(html).toContain("You need an account on this site.");
    expect(html).not.toContain("You need a GitHub account.");
    expect(html).toContain(
      "Submit your own work. Passing off another contestant&#x27;s work as your own is not allowed.",
    );
  });

  it("renders every section, none of them empty", () => {
    for (const heading of [
      "Eligibility",
      "Scope of authorized testing",
      "Your submissions",
      "Scoring and prizes",
    ]) {
      expect(html).toContain(heading);
    }
    // Every section is a <ul> of <li>s; an empty one would render the heading
    // with nothing under it.
    expect(html).not.toMatch(/<ul[^>]*><\/ul>/);
  });

  it("keeps the platform's own terms", () => {
    expect(html).toContain("Prizes go to the top individuals and top teams overall.");
    expect(html).toContain("Organizer decisions on scoring disputes are final.");
  });

  it("names no module's game", () => {
    expect(findSecureDevLeaks(html)).toEqual([]);
  });
});
