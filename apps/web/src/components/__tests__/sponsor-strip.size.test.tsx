// Landing-strip logo sizing (organizer setting, sponsorLogoSize). Separate
// from sponsor-boundary.test.tsx, which fixes the size at "no override" —
// this file is the one place that actually varies AdminSettings.sponsorLogoSize
// and checks the strip picks the matching size class.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));

const SPONSOR_ID = "zzyzx-sec-ab12cd";
const fixtureSponsors = [
  {
    id: SPONSOR_ID,
    name: "Zzyzx Security Labs",
    url: "https://zzyzx.example",
    blurb: "",
    tier: "gold" as const,
    order: 0,
    logo: { type: "image/png" as const, bytes: 100, w: 40, h: 40, etag: "0".repeat(16) },
  },
];
vi.mock("@/lib/sponsors-store", () => ({
  listSponsors: vi.fn(async () => fixtureSponsors),
}));

// The double delegates to whatever this file mocks on @/lib/admin-store —
// see enabled-modules-baked.ts's own header for why that indirection exists.
const mockGetAdminSettings = vi.fn<() => Promise<{ sponsorLogoSize: string | null }>>();
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: mockGetAdminSettings }));

const { default: SponsorStrip } = await import("@/components/sponsor-strip");

describe("SponsorStrip — organizer-set logo size", () => {
  it("defaults to the medium size when nothing is stored", async () => {
    mockGetAdminSettings.mockResolvedValueOnce({ sponsorLogoSize: null });
    const html = renderToStaticMarkup(await SponsorStrip());
    expect(html).toContain("h-10");
    expect(html).toContain("max-w-[12rem]");
  });

  it("renders the small preset", async () => {
    mockGetAdminSettings.mockResolvedValueOnce({ sponsorLogoSize: "sm" });
    const html = renderToStaticMarkup(await SponsorStrip());
    expect(html).toContain("h-6");
    expect(html).toContain("max-w-[8rem]");
  });

  it("renders the large preset", async () => {
    mockGetAdminSettings.mockResolvedValueOnce({ sponsorLogoSize: "lg" });
    const html = renderToStaticMarkup(await SponsorStrip());
    expect(html).toContain("h-14");
    expect(html).toContain("max-w-[16rem]");
  });

  it("falls back to medium if the settings read itself fails", async () => {
    mockGetAdminSettings.mockRejectedValueOnce(new Error("redis blip"));
    const html = renderToStaticMarkup(await SponsorStrip());
    expect(html).toContain("h-10");
  });
});
