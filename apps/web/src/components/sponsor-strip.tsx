// Landing-page sponsor credit row (issue #405). Renders in the hero, just
// below the event's dates/location line — and returns null on an empty
// sponsor list, so a box with no sponsors ships zero sponsor pixels anywhere.
//
// Grayscale-by-default with a hover color reveal: this reads as a credit
// row, not an ad rail, which is the whole design constraint the sponsors
// feature has to hold (see docs/decisions.md's sponsors ADR). Each link
// carries `rel="sponsored"` (plus the usual noopener/noreferrer/nofollow) —
// these are PAID links, and this site should not launder PageRank for them.
//
// Async Server Component: called (not mounted) by app/page.tsx for the same
// reason SiteFooter is — a nested async child suspends under
// `renderToStaticMarkup`, which is how this repo's landing-page tests render
// the page.

import Link from "next/link";
import { listSponsors } from "@/lib/sponsors-store";
import { getAdminSettingsSnapshot } from "@/lib/enabled-modules";
import type { SponsorLogoSize } from "@/lib/sponsors-keys";

/** Landing-strip sizing (issue: logos read as illegible flecks at the
 *  original fixed size). "md" is this surface's long-standing default —
 *  unchanged unless an organizer picks something else in /admin's Sponsors
 *  tab. The leaderboard's projector display reads the same setting with its
 *  own viewport-scaled values (display-board.tsx); /sponsors is untouched by
 *  it and keeps its fixed size on purpose. */
const LOGO_SIZE_CLASSES: Record<SponsorLogoSize, string> = {
  sm: "h-6 w-auto max-w-[8rem]",
  md: "h-10 w-auto max-w-[12rem]",
  lg: "h-14 w-auto max-w-[16rem]",
};

export default async function SponsorStrip() {
  // Fail open like SiteFooter's own sponsor read: a Redis blip on this
  // cosmetic block must not break the landing page. The settings snapshot
  // already fails open to null internally (enabled-modules.ts); ?? "md"
  // below covers both that and "nothing stored yet".
  const [sponsors, settings] = await Promise.all([
    listSponsors().catch(() => []),
    getAdminSettingsSnapshot(),
  ]);
  if (sponsors.length === 0) return null;
  const logoClasses = LOGO_SIZE_CLASSES[settings?.sponsorLogoSize ?? "md"];

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-[#8f8f9b]">Sponsored by</p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {sponsors.map((sponsor) => (
          <a
            key={sponsor.id}
            href={sponsor.url}
            target="_blank"
            rel="noopener noreferrer nofollow sponsored"
            className="group flex flex-col items-start gap-1"
          >
            {sponsor.logo && (
              <img
                src={`/api/sponsors/logo/${sponsor.id}`}
                alt={`${sponsor.name} logo`}
                width={sponsor.logo.w}
                height={sponsor.logo.h}
                loading="lazy"
                decoding="async"
                className={`${logoClasses} object-contain opacity-80 grayscale transition-all duration-150 group-hover:opacity-100 group-hover:grayscale-0`}
              />
            )}
            <span className="font-mono text-xs text-muted transition-colors group-hover:text-zinc-300">
              {sponsor.name}
            </span>
          </a>
        ))}
      </div>
      <Link href="/sponsors" className="font-mono text-xs text-[#8f8f9b] transition-colors hover:text-zinc-300">
        About sponsors
      </Link>
    </div>
  );
}
