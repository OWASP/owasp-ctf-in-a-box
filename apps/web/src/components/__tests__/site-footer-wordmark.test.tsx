// The footer's terminal-prompt wordmark. The header has always rendered the
// organizer's runtime event name there and site-header.test.tsx forbids the
// `owasp-ctf` slug from appearing in it; the footer rendered that slug as a
// hardcoded string, so the two ends of every page disagreed the moment an
// organizer renamed their event — and, after the September 2026 rename,
// showed the retired brand under the new one. This pins the footer to the
// same source the header reads.
//
// Same harness as site-footer-owasp.test.tsx: the real `@/lib/site` with the
// baked settings double, so `event.name` is the spec default rather than a
// fixture string the component could not have got wrong.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("@/lib/sponsors-store", () => ({ listSponsors: vi.fn(async () => []) }));

const { default: SiteFooter } = await import("@/components/site-footer");

describe("the footer's wordmark", () => {
  it("renders the runtime event name after the prompt, like the header", async () => {
    const html = renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
    expect(html).toContain("</span> OWASP CTF in a Box");
  });

  it("no longer hardcodes the owasp-ctf slug as the wordmark", async () => {
    const html = renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
    // Scoped to the prompt: the repo link's href legitimately contains the
    // substring, so a bare not.toContain("owasp-ctf") would be wrong here.
    expect(html).not.toContain("</span> owasp-ctf");
  });
});
