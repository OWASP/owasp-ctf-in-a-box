// The OWASP attribution in the shared footer. The OWASP Project Policy asks
// that the links back to owasp.org, the project home page and the repo be
// prominent on any domain a project maintains — an event box runs on the
// organizer's own hostname (ctf.example.org, a Fly app, whatever they point
// at it), so this footer is the surface that obligation lands on.
//
// This file uses the REAL `@/lib/site` rather than a mock, on purpose: the
// thing under test is that the three constants reach rendered `href`s. A
// mocked `getSite` would let the component render three links to fixture
// URLs and pass while the shipped constants were wrong or absent — the
// vacuous pass this repo keeps finding (see AGENTS.md).
//
// @testing-library/react is not a dependency here; a static render is
// enough, same constraint as sponsor-boundary.test.tsx.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
// getSite() reads the admin settings snapshot; the real one calls
// connection(), which throws outside a request scope. The baked double fails
// open to "no override", which is what an unconfigured box looks like.
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// No sponsors: the attribution must not depend on the sponsor row, which
// renders only when there are sponsors to name.
vi.mock("@/lib/sponsors-store", () => ({ listSponsors: vi.fn(async () => []) }));

const { default: SiteFooter } = await import("@/components/site-footer");

describe("the footer's OWASP attribution", () => {
  it("links owasp.org, the project home page and the repo", async () => {
    const html = renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
    expect(html).toContain('href="https://owasp.org/"');
    expect(html).toContain('href="https://owasp.org/projects/ctf-in-a-box"');
    expect(html).toContain('href="https://github.com/OWASP/owasp-ctf-in-a-box"');
  });

  it("carries the trademark notice and the statement of non-endorsement", async () => {
    const html = renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
    // Verbatim, because both sentences are the Foundation's wording (Branding
    // Guidelines, "Statement of Non-Endorsement") and not ours to paraphrase.
    expect(html).toContain("OWASP® is a registered trademark of the OWASP Foundation.");
    expect(html).toContain("OWASP does not endorse or recommend any product or service.");
  });

  it("renders with no event identity configured and no sponsors", async () => {
    // The anti-vacuous half: the two assertions above would also pass if the
    // footer happened to render this block only under some condition that
    // this fixture accidentally satisfies. Nothing here is configured — no
    // contact email, no Discord, no sponsors — so the block is unconditional.
    const html = renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("Sponsored by");
    expect(html).toContain("OWASP Foundation");
  });
});
