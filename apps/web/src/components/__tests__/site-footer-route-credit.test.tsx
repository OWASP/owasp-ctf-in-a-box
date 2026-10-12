// The footer's text sponsor credit steps aside on pages that credit the
// sponsors themselves (ADR 66): the regular leaderboard now carries the
// sponsor strip under its header, so its shared footer must not name them
// again. Every other route keeps the credit.
//
// The footer is rendered by the shared (site) layout, which cannot see the
// route; the credit decides for itself with usePathname, mocked here.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const nav: { path: string | null } = { path: "/" };
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/sponsors-store", () => ({
  listSponsors: async () => [
    {
      id: "zzyzx-1",
      name: "Zzyzx Security Labs",
      url: "https://zzyzx.example",
      blurb: "",
      tier: "gold",
      order: 0,
      logo: null,
    },
  ],
}));
vi.mock("@/lib/site", () => ({
  getSite: async () => ({
    name: "Fixture CTF",
    dates: "",
    location: "",
    discordUrl: "",
    contactEmail: "",
    owaspUrl: "https://owasp.org/",
    owaspProjectUrl: "https://owasp.org/projects/ctf-in-a-box",
    sourceUrl: "https://github.com/OWASP/owasp-ctf-in-a-box",
  }),
  legalLinks: [],
}));

const { default: SiteFooter } = await import("@/components/site-footer");

async function footerOn(path: string | null): Promise<string> {
  nav.path = path;
  return renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
}

beforeEach(() => {
  nav.path = "/";
});

describe("footer sponsor credit — pages with their own sponsor strip", () => {
  it("names the sponsors on an ordinary page (anti-vacuous)", async () => {
    const html = await footerOn("/rules");
    expect(html).toContain("Sponsored by");
    expect(html).toContain("Zzyzx Security Labs");
  });

  it("leaves the credit out on the regular leaderboard, which credits them under its header", async () => {
    const html = await footerOn("/leaderboard");
    expect(html).not.toContain("Sponsored by");
    expect(html).not.toContain("Zzyzx Security Labs");
  });

  it("keeps the credit when the route cannot be read", async () => {
    const html = await footerOn(null);
    expect(html).toContain("Sponsored by");
  });

  it("keeps the credit on a page whose path only starts like the leaderboard's", async () => {
    const html = await footerOn("/leaderboard-archive");
    expect(html).toContain("Sponsored by");
  });
});
