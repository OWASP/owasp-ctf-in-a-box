// The 404's route directory under an organizer rename.
//
// The card label is `titleOverride || nav.label`, and that expression is the
// naming rule in miniature: an explicit rename replaces the module's name
// wherever it appears, and with NO rename the surface's own default stands
// (secure-development's nav label is "Challenges" while its display name is
// "Secure Development" — one names the destination page, the other the
// module). Both mutations of it survived the suite: `nav.label` alone drops
// the organizer's rename, `title` alone renames a nav entry nobody renamed.
//
// One render with one module renamed and one not is what closes both at once.
//
// Own file for the usual `vi.mock` hoisting reason.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development", "quiz"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({
    moduleOverrides: { quiz: { title: "Round 1" } },
    enabledModuleIds: ["secure-development", "quiz"],
    // The live target list now comes from here, not the (now-dead) event.yaml
    // bake (issue #386, PR 2) — one target, so "1 target" below still pins a
    // real count rather than a coincidence of the default.
    secureDevTargets: ["dvwa"],
  }),
}));

import NotFound from "@/app/not-found";

const html = await NotFound().then(renderToStaticMarkup);

/** The card heading rendered for a given href. */
function cardLabel(href: string): string | undefined {
  const card = html.split(`href="${href}"`)[1];
  return card?.match(/<h2[^>]*>([^<]*)<\/h2>/)?.[1];
}

describe("the 404's route directory", () => {
  it("uses the organizer's rename for the module they renamed", () => {
    expect(cardLabel("/quiz")).toBe("Round 1");
    expect(html).not.toContain(">Quiz</h2>");
  });

  it("keeps the nav label — not the display name — for the module they did not", () => {
    expect(cardLabel("/challenges")).toBe("Challenges");
    expect(html).not.toContain("Secure Development");
  });

  it("still describes each route with its own registry card", () => {
    expect(html).toContain("Every question the organizers have published.");
    expect(html).toContain("Every challenge across the 1 target.");
  });
});
