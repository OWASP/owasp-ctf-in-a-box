// /how-to-play on a secure-development-only event (six targets). This is the
// "nothing moved" suite: every string here was on the
// page before it was composed from the module registry, and is asserted
// verbatim so a reword during a future refactor fails loudly rather than
// quietly changing what contestants are told.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// The page now reads GITHUB_ORG through bootstrap-env rather than the
// (now-dead) event.yaml bake — this is the "nothing moved" suite, so it pins
// the same org the vendored config used to bake.
vi.mock("@/lib/bootstrap-env", () => ({ getGithubOrg: () => "OWASP-CTF" }));
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `enabledModuleIds` off this settings object
  // and falls back to the (baked-shim-mocked) `defaultModuleIds`, which is
  // ALL four registered ids, not the shipped set — so this must name the
  // shipped config's module list explicitly, or the page composes a guide
  // for every module the registry knows, not the one this event runs.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["secure-development"] }),
}));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => id === "secure-development",
}));

import HowToPlay, { generateMetadata } from "@/app/(site)/how-to-play/page";

const html = await HowToPlay().then(renderToStaticMarkup);
const metadata = await generateMetadata();

describe("/how-to-play on a secure-development event", () => {
  it("keeps the module's own lede as the page description", () => {
    expect(html).toContain(
      "New to the competition? Here&#x27;s everything you need to go from a GitHub sign-in to your first patched challenge.",
    );
  });

  it("renders the loop callout", () => {
    expect(html).toContain("The loop");
    expect(html).toContain(
      'find the flaw <span class="text-zinc-600">→</span> patch it <span class="text-zinc-600">→</span> open a PR <span class="text-zinc-600">→</span> CI scores it',
    );
    expect(html).toContain("There are no flags to submit.");
  });

  it("renders the AI callout with the Secure Agent Playbook link", () => {
    expect(html).toContain("Please use AI");
    expect(html).toContain(
      '<a href="https://github.com/OWASP/secure-agent-playbook" target="_blank" rel="noopener noreferrer" class="ds-link">Secure Agent Playbook</a>',
    );
  });

  it("renders all five numbered steps", () => {
    for (const title of [
      "Sign in with GitHub",
      "Pick a target and a challenge",
      "Find the vulnerability",
      "Patch it and open a pull request",
      "Get scored automatically",
    ]) {
      expect(html).toContain(title);
    }
  });

  it("interpolates the event's real targets and org into the steps", () => {
    expect(html).toContain(
      "Browse the 6 vulnerable apps on the Challenges page: Juice Shop, DVWA, WebGoat, Security Shepherd, VulnerableApp, and VAmPI.",
    );
    expect(html).toContain("Fork the target&#x27;s repo under the OWASP-CTF org");
  });

  it("renders the Juice Shop worked example, with its code blocks and bonus", () => {
    expect(html).toContain('id="first-patch"');
    expect(html).toContain("Your first patch, end to end");
    expect(html).toContain("gh repo fork OWASP-CTF/juice-shop --clone");
    expect(html).toContain("git checkout -b fix/login-sql-injection");
    expect(html).toContain('<span class="text-zinc-200">Login Bender</span>');
  });

  // issue #379: every provisioned target's only scoring branch is `ctf` —
  // ctf-setup.sh's ctf-branch step creates it and drop-old deletes
  // master/main — so a PR opened against `main` (the worked example's old
  // copy) has no base branch to land on.
  it("opens the worked example's PR against ctf, not main", () => {
    expect(html).toContain("gh pr create --repo OWASP-CTF/juice-shop --base ctf");
    expect(html).not.toContain("--base main");
    expect(html).toContain("the base branch is ctf");
    expect(html).not.toContain("the base branch is main");
  });

  // The score-comment promise must name the ctf-score.yml workflow's actual
  // heading ("## 🏆 CTF Patch Score"), not the invented "🏁 Score recorded".
  it("promises the workflow's real score-comment heading", () => {
    expect(html).toContain("CTF Patch Score");
    expect(html).not.toContain("Score recorded");
  });

  it("renders the platform's good-to-know and scoring cards", () => {
    expect(html).toContain("Good to know");
    expect(html).toContain("How scoring works");
    expect(html).toContain(
      "Every challenge is worth a fixed number of points based on difficulty, and harder vulnerabilities pay out more.",
    );
  });

  it("renders the module CTA alongside the platform's links", () => {
    expect(html).toContain("Browse challenges");
    expect(html).toContain('href="/challenges"');
    expect(html).toContain("Read the rules");
    expect(html).toContain("View the leaderboard");
  });

  it("describes the page with the module's meta description", () => {
    expect(metadata.description).toBe(
      "Step-by-step guide to OWASP Secure Development: fork a target, patch a real vulnerability, open a PR, and get scored automatically.",
    );
  });
});
