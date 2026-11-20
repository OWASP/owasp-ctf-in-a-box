// /privacy on a Secure Development event.
//
// Two stores are not keyed by the player id alone here, and the notice has to
// say so: a score from an unlinked PR author is held under that GitHub login
// (`ctf:sd:held:*`) until it is linked, and an account made by a GitHub
// sign-in has no username until one is set, so its GitHub login is its public
// name (displayNameOf falls back to it).
//
// Own file for the usual `vi.mock` hoisting reason.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development"]),
);

import Privacy from "@/app/(site)/privacy/page";

const html = renderToStaticMarkup(await Privacy()).replace(/\s+/g, " ");

describe("/privacy in a Secure Development event", () => {
  it("names the held score as the one record keyed by a GitHub login", () => {
    expect(html).toContain(
      "never against your name or a GitHub login, with one exception: a Secure Development score from a GitHub account that is not linked yet is held under that GitHub login until its author links it.",
    );
    expect(html).toContain("(apart from a held score, keyed by its GitHub login until that login is linked)");
  });

  it("says a GitHub-made account without a username shows its login publicly", () => {
    expect(html).toContain("until then its GitHub login is the name everyone sees.");
    expect(html).toContain("its GitHub login is its public name until you set one.");
  });
});
