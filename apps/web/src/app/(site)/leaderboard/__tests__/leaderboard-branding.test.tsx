// The regular leaderboard carries the event's identity (ADR 66): the uploaded
// event logo beside the title and the sponsor strip under the header, above
// the board. Both are cosmetic, so both fail open — a read error leaves the
// standings on screen without them.
//
// The page is rendered for real with its data sources mocked. <Leaderboard>
// (the interactive client board) is replaced by a marker: what it renders is
// covered by its own suites, and the marker is what lets these tests check the
// strip sits ABOVE the board.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/leaderboard", useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/image", () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} />
  ),
}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development"]),
);
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/launch", () => ({ redirectIfNotLaunched: async () => ({ preview: false }) }));
vi.mock("@/lib/leaderboard/folded", () => ({
  getFoldedLeaderboard: async () => ({ generatedAt: "2026-10-07T13:00:00.000Z", entries: [], teams: [] }),
}));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSourceMode: async () => "lambda" }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules: async () => [] }));
vi.mock("@/lib/enabled-apps", () => ({ getEnabledApps: async () => [] }));
vi.mock("@/lib/site", () => ({
  getSite: async () => ({ name: "Red Team Space CTF", timeZone: "UTC", ctfStartsAt: null }),
}));
vi.mock("@/components/leaderboard", () => ({ default: () => <div data-testid="board">BOARD</div> }));

const sponsorsState: { list: unknown[] | Error } = { list: [] };
vi.mock("@/lib/sponsors-store", () => ({
  listSponsors: async () => {
    if (sponsorsState.list instanceof Error) throw sponsorsState.list;
    return sponsorsState.list;
  },
}));

const imagesState: { logo: unknown } = { logo: undefined };
vi.mock("@/lib/event-images-site", () => ({
  getEventImages: async () => (imagesState.logo ? { logo: imagesState.logo } : {}),
}));

const { default: LeaderboardPage } = await import("@/app/(site)/leaderboard/page");
const { default: HeaderLogo } = await import("@/components/header-logo");

const LOGO = { type: "image/png", bytes: 2048, w: 482, h: 603, etag: "0123456789abcdef" };
const SPONSOR = {
  id: "versprite-1",
  name: "Versprite",
  url: "https://versprite.example",
  blurb: "",
  tier: "gold",
  order: 0,
  logo: { type: "image/png", bytes: 100, w: 300, h: 100 },
};

async function render(): Promise<string> {
  return renderToStaticMarkup((await LeaderboardPage({})) as ReactElement);
}

/** The markup before the board marker: the header and anything above the board. */
const aboveBoard = (html: string) => html.slice(0, html.indexOf("BOARD"));

beforeEach(() => {
  sponsorsState.list = [];
  imagesState.logo = undefined;
});

describe("leaderboard header — event logo", () => {
  it("shows the uploaded event logo beside the title", async () => {
    imagesState.logo = LOGO;
    const head = aboveBoard(await render());
    const img = head.match(/<img[^>]*alt="Red Team Space CTF logo"[^>]*>/)?.[0] ?? "";
    expect(img).toContain('src="/api/event/logo?v=0123456789abcdef"');
    expect(img).toContain('width="482"');
    expect(img).toContain('height="603"');
    expect(head.indexOf(img)).toBeLessThan(head.indexOf("Leaderboard</h1>"));
  });

  it("lets the logo wrap above the title on a narrow screen rather than widen the page", async () => {
    imagesState.logo = LOGO;
    const head = aboveBoard(await render());
    const row = head.match(/<div class="([^"]*)"><img[^>]*alt="Red Team Space CTF logo"/)?.[1] ?? "";
    expect(row.split(/\s+/)).toContain("flex-wrap");
  });

  it("shows the uploaded logo instead of the default mark", async () => {
    imagesState.logo = LOGO;
    const head = aboveBoard(await render());
    expect(head).not.toContain("owasp-logo.png");
  });

  it("falls back to the default OWASP mark, as the landing page does, when no logo is uploaded", async () => {
    const head = aboveBoard(await render());
    const img = head.match(/<img[^>]*alt="OWASP"[^>]*>/)?.[0] ?? "";
    expect(img).toContain("owasp-logo.png");
    expect(img).toContain("invert");
    expect(head.indexOf(img)).toBeLessThan(head.indexOf("Leaderboard</h1>"));
    expect(head).not.toContain("/api/event/logo");
  });
});

describe("leaderboard header — sponsor strip", () => {
  it("credits the sponsors under the header, above the board", async () => {
    sponsorsState.list = [SPONSOR];
    const html = await render();
    const head = aboveBoard(html);
    expect(head).toContain("Sponsored by");
    expect(head).toContain('src="/api/sponsors/logo/versprite-1"');
    expect(head).toContain('rel="noopener noreferrer nofollow sponsored"');
    expect(head.indexOf("Sponsored by")).toBeGreaterThan(head.indexOf("Leaderboard</h1>"));
  });

  it("renders nothing sponsor-shaped when there are no sponsors", async () => {
    const head = aboveBoard(await render());
    expect(head).not.toContain("Sponsored by");
    expect(head).not.toContain("/api/sponsors/logo/");
  });

  it("still renders the board when the sponsor read fails", async () => {
    sponsorsState.list = new Error("NOAUTH");
    const html = await render();
    expect(html).toContain("BOARD");
    expect(aboveBoard(html)).not.toContain("Sponsored by");
  });
});

// No DOM test environment here, so the handler is called directly on the
// element HeaderLogo returns, the same technique display-board.header uses.
describe("HeaderLogo — a logo that fails to load is hidden", () => {
  it("hides the image on a load error, leaving the title", () => {
    type Img = ReactElement<{ onError?: (e: { currentTarget: { hidden: boolean } }) => void }>;
    const el = HeaderLogo({ src: "/api/event/logo?v=x", w: 10, h: 10, alt: "x logo" }) as Img;
    const target = { hidden: false };
    el.props.onError?.({ currentTarget: target });
    expect(target.hidden).toBe(true);
  });
});
