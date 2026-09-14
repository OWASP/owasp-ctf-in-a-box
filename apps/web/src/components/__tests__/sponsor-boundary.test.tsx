// The sponsors guardrail (issue #405): sponsors must appear ONLY on their
// designated surfaces — the landing-page strip, the footer's text-only
// credit line, the /sponsors page, and (per this session's extension to the
// issue) the leaderboard's projector display (`?display=1`) — and nowhere
// else. A full multi-route render (header, hero, /challenges, /flags,
// /quiz, /ai, /rules, /how-to-play) would need each of those routes' own
// heavy per-page mock rig duplicated into this one file; instead this file
// pins the boundary at the COMPONENT layer, which is where every one of
// those pages would actually receive sponsor data from if it ever did.
// `leaderboard/page.tsx` itself only calls `listSponsors()` inside its
// `if (wantsDisplay)` branch — a plain code-structure guarantee that the
// non-display leaderboard render (the one every other page's <Leaderboard/>
// overlay shares) never even reads sponsor data, let alone renders it.
//
// @testing-library/react is not a dependency here — see site-header.test.tsx
// for the same constraint. A static render via renderToStaticMarkup is
// enough: none of the assertions below depend on interactivity.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/image", () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} />
  ),
}));

const SPONSOR_NAME = "Zzyzx Security Labs"; // a distinctive token, unlikely to collide with real copy
const SPONSOR_ID = "zzyzx-sec-ab12cd";
const SPONSOR_LOGO_SRC = `/api/sponsors/logo/${SPONSOR_ID}`;

const fixtureSponsors = [
  {
    id: SPONSOR_ID,
    name: SPONSOR_NAME,
    url: "https://zzyzx.example",
    blurb: "A fixture sponsor.",
    tier: "gold" as const,
    order: 0,
    logo: { type: "image/png" as const, bytes: 100, w: 40, h: 40, etag: "0".repeat(16) },
  },
];

vi.mock("@/lib/sponsors-store", () => ({
  listSponsors: vi.fn(async () => fixtureSponsors),
  tierRank: (t: string) => ({ gold: 0, silver: 1, community: 2 })[t] ?? 3,
}));
vi.mock("@/lib/site", () => ({
  getSite: vi.fn(async () => ({ name: "Fixture CTF", dates: "", location: "", discordUrl: "", contactEmail: "" })),
  legalLinks: [],
}));

const { default: SponsorStrip } = await import("@/components/sponsor-strip");
const { default: SiteFooter } = await import("@/components/site-footer");
const { default: SponsorsPage } = await import("@/app/(site)/sponsors/page");
const { default: DisplayBoard } = await import("@/components/display-board");

describe("sponsor surfaces — positive case (anti-vacuous)", () => {
  it("the landing-page strip renders the sponsor's logo, name-in-alt, and a sponsored rel", async () => {
    const html = renderToStaticMarkup(await SponsorStrip());
    expect(html).toContain(SPONSOR_LOGO_SRC);
    expect(html).toContain(SPONSOR_NAME);
    expect(html).toContain("sponsored");
  });

  it("/sponsors lists the sponsor, its blurb, and the fixed OWASP disclaimer", async () => {
    const html = renderToStaticMarkup(await SponsorsPage());
    expect(html).toContain(SPONSOR_NAME);
    expect(html).toContain("A fixture sponsor.");
    expect(html).toContain("OWASP does not endorse sponsors");
  });

  it("the leaderboard display board renders a sponsor's logo when given one", () => {
    const html = renderToStaticMarkup(
      <DisplayBoard
        rows={[]}
        eventName="Fixture CTF"
        phaseLabel={null}
        sponsors={[{ key: SPONSOR_ID, name: SPONSOR_NAME, logoSrc: SPONSOR_LOGO_SRC, w: 40, h: 40 }]}
      />,
    );
    expect(html).toContain(SPONSOR_LOGO_SRC);
  });
});

describe("sponsor surfaces — boundary", () => {
  it("the footer names the sponsor in text, but renders no <img> for it (text only, no logos)", async () => {
    const html = renderToStaticMarkup(await SiteFooter({ navLinks: [] }));
    expect(html).toContain(SPONSOR_NAME);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="/sponsors"');
  });

  it("the disclaimer is fixed copy, not sourced from anything the sponsor record could carry", async () => {
    const html = renderToStaticMarkup(await SponsorsPage());
    // The exact disclaimer sentence must be present verbatim — proving it's
    // not derived from `blurb`/`name`, which this fixture sponsor could
    // otherwise be mistaken for satisfying by coincidence.
    expect(html).toContain(
      "Sponsors fund this event. They have no influence over challenge content, scoring, or results.",
    );
  });

  it("the display board renders nothing sponsor-shaped when given no sponsors (the default)", () => {
    const html = renderToStaticMarkup(<DisplayBoard rows={[]} eventName="Fixture CTF" phaseLabel={null} />);
    expect(html).not.toContain("/api/sponsors/logo/");
  });
});
