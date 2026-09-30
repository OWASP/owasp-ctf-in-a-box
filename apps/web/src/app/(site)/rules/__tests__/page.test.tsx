// /rules on the SHIPPED event config (secure-development). Same "nothing
// moved" contract as how-to-play's suite: every bullet below was on the page
// before the module split, and is pinned verbatim.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["secure-development"] }),
}));

import Rules from "@/app/(site)/rules/page";

const html = await Rules().then(renderToStaticMarkup);

describe("/rules on a secure-development event", () => {
  it("renders every section", () => {
    for (const heading of ["Teams", "Fair play", "Conduct", "Scoring &amp; prizes"]) {
      expect(html).toContain(heading);
    }
  });

  it("keeps the platform's own rules", () => {
    expect(html).toContain("Scoring is per team, and you need one before anything you solve counts.");
    expect(html).toContain("Each person belongs to at most one team at a time.");
    expect(html).toContain("Be excellent to the volunteers, organizers, and your fellow competitors.");
    expect(html).toContain("Prizes are awarded to the top individuals and top teams overall.");
    expect(html).toContain("Organizer decisions on scoring disputes are final.");
    expect(html).toContain("OWASP Code of Conduct");
  });

  it("keeps the module's rules, verbatim", () => {
    expect(html).toContain(
      "Points for a patch credit the pull request&#x27;s author — open every PR from the same GitHub account you sign in with, or your score lands on a row you can&#x27;t see.",
    );
    expect(html).toContain(
      "Only the 6 challenge targets (Juice Shop, DVWA, WebGoat, Security Shepherd, VulnerableApp, and VAmPI) are in scope. Do not attack the CI scoring pipeline, the leaderboard, or other contestants&#x27; forks.",
    );
    expect(html).toContain(
      "Submit your own work. Don&#x27;t publish full solutions or patches for others to copy during the event.",
    );
    expect(html).toContain(
      "Automated mass-submission or spamming pull requests to farm scoring runs will get your account rate-limited or disqualified.",
    );
    expect(html).toContain(
      "Found a bug in a challenge, the scorer, or the site itself? Report it to an organizer instead of exploiting it for an unfair edge.",
    );
    expect(html).toContain("Revealing a hint deducts points from your total, and hint purchases are final.");
  });

  it("renders the Please-use-AI rule with its emphasis and playbook link", () => {
    expect(html).toContain(
      '<span class="text-white">Please use AI.</span> Finding and patching these vulnerabilities with an AI agent is the intended workflow',
    );
    expect(html).toContain(
      '<a href="https://github.com/OWASP/secure-agent-playbook" target="_blank" rel="noopener noreferrer" class="ds-link">Secure Agent Playbook</a>',
    );
  });

  // The dedupe property itself: the identity rule is the platform's ONE
  // sentence, not one per module — three near-identical adjacent bullets is
  // the regression this pins against (issue #200, tier 4).
  it("states the identity rule exactly once, for every module at once", () => {
    expect(html.split("identity for scoring").length - 1).toBe(1);
  });

  // Module bullets lead "Fair play" and "Scoring & prizes" (they are the
  // specific ones) and follow the platform's in "Teams" and "Conduct" — the
  // order the page has always rendered.
  it("orders module rules against the platform's as the page always has", () => {
    expect(html.indexOf("Each person belongs to at most one team")).toBeLessThan(
      html.indexOf("open every PR from the same GitHub account"),
    );
    expect(html.indexOf("Revealing a hint deducts points")).toBeLessThan(
      html.indexOf("Prizes are awarded to the top individuals"),
    );
  });
});
