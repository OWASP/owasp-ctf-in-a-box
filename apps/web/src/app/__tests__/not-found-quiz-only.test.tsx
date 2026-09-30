// The 404 on a quiz-only event.
//
// It offered a card to /challenges — a route that 404s on this event, reached
// from the 404 page itself — described as "Every challenge across the 0
// targets", and omitted /quiz entirely, while the footer rendered directly
// beneath it listed Quiz correctly. The route directory is now built from the
// enabled modules, like every other module-aware surface.
//
// Own file for the usual `vi.mock` hoisting reason.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  findSecureDevLeaks,
  normalizeHtml,
  SECURE_DEV_PATTERNS,
  SECURE_DEV_TERMS,
} from "../(site)/__tests__/secure-dev-terms";

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

import NotFound from "@/app/not-found";

const html = await NotFound().then(renderToStaticMarkup);

describe("the 404 in a quiz-only event", () => {
  it("offers the module's own route", () => {
    expect(html).toContain('href="/quiz"');
    expect(html).toContain("Every question the organizers have published.");
  });

  it("offers no card to a route this event does not have", () => {
    expect(html).not.toContain('href="/challenges"');
    expect(html).not.toContain("0 targets");
  });

  it("keeps the platform routes", () => {
    for (const href of ["/how-to-play", "/leaderboard", "/faq"]) {
      expect(html).toContain(`href="${href}"`);
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
});
