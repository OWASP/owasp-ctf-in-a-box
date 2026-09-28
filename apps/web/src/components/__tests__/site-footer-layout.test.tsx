// The footer's layout (#474). It used to be one <footer> holding four rows,
// each after the first drawing its own full-width `border-t` — every feature
// (legal pages, the OWASP attribution of #456, the sponsor credit of #417)
// appended a band, and on the live box it read as four stacked footers. It is
// now a main block plus one bottom bar, and these tests pin the shape:
//
// - at most one divider inside the footer (the bottom bar's);
// - reading order is source order, so the phone column and a screen reader
//   agree — wordmark, main nav, policy links, attribution, then the bottom
//   bar's trademark notice and sponsors — and nothing uses CSS `order`;
// - every link carries vertical padding, so its target meets WCAG 2.5.8;
// - the landing page, whose hero strip already credits the sponsors, can
//   leave the footer's credit out, and every other caller keeps it.
//
// Same harness as site-footer-owasp.test.tsx: the real `@/lib/site` with the
// baked settings double. Only the sponsor list is swapped per test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));

const sponsors = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/lib/sponsors-store", () => ({ listSponsors: vi.fn(async () => sponsors.list) }));

const { default: SiteFooter } = await import("@/components/site-footer");

const SPONSOR = {
  id: "zzyzx-sec-ab12cd",
  name: "Zzyzx Security Labs",
  url: "https://zzyzx.example",
  blurb: "",
  tier: "gold",
  order: 0,
};
const NAV = [
  { href: "/challenges", label: "Challenges" },
  { href: "/leaderboard", label: "Leaderboard" },
];

async function render(opts: { creditSponsors?: boolean } = {}) {
  return renderToStaticMarkup(await SiteFooter({ navLinks: NAV, ...opts }));
}

beforeEach(() => {
  sponsors.list = [];
});

describe("the footer's layout", () => {
  it("draws at most one divider inside the footer, even with every row present", async () => {
    sponsors.list = [SPONSOR];
    const html = await render();
    // The <footer> element's own top border separates it from the page; any
    // other `border-t` is a divider inside it.
    const inner = html.slice(html.indexOf(">") + 1);
    expect(inner.match(/\bborder-t\b/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(html).toContain("Sponsored by");
  });

  it("reads in source order: wordmark, nav, policies, attribution, trademark, sponsors", async () => {
    sponsors.list = [SPONSOR];
    const html = await render();
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, `missing ${needle}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at("</span> OWASP CTF in a Box"),
      at('href="/challenges"'),
      at('href="/terms"'),
      at("OWASP Foundation</a>"),
      at("OWASP® is a registered trademark"),
      at("Sponsored by"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("never reorders with CSS order, so the screen-reader order is the visual one", async () => {
    sponsors.list = [SPONSOR];
    expect(await render()).not.toMatch(/\border-/);
  });

  it("labels the main nav, alongside the policy nav's existing label", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Site"');
    expect(html).toContain('aria-label="Policies and contact"');
  });

  it("pads every link so its target meets WCAG 2.5.8", async () => {
    sponsors.list = [SPONSOR];
    const html = await render();
    const anchors = html.match(/<a\b[^>]*>/g) ?? [];
    // Nav (2) + policy links (3) + attribution (3) + sponsor + About sponsors.
    expect(anchors.length).toBeGreaterThanOrEqual(10);
    for (const a of anchors) expect(a, a).toMatch(/\bpy-1\b/);
  });
});

describe("the footer's sponsor credit", () => {
  it("is present by default when there are sponsors", async () => {
    sponsors.list = [SPONSOR];
    const html = await render();
    expect(html).toContain("Sponsored by");
    expect(html).toContain('rel="noopener noreferrer nofollow sponsored"');
  });

  it("is absent when there are no sponsors", async () => {
    expect(await render()).not.toContain("Sponsored by");
  });

  it("is left out when the caller credits them elsewhere (the landing page's hero strip)", async () => {
    sponsors.list = [SPONSOR];
    const html = await render({ creditSponsors: false });
    expect(html).not.toContain("Sponsored by");
    expect(html).not.toContain(SPONSOR.name);
  });

  it("leaves the OWASP attribution in place when the sponsor credit is left out", async () => {
    sponsors.list = [SPONSOR];
    const html = await render({ creditSponsors: false });
    expect(html).toContain('href="https://owasp.org/"');
    expect(html).toContain('href="https://owasp.org/projects/ctf-in-a-box"');
    expect(html).toContain('href="https://github.com/OWASP/owasp-ctf-in-a-box"');
    expect(html).toContain("OWASP® is a registered trademark of the OWASP Foundation.");
  });
});
