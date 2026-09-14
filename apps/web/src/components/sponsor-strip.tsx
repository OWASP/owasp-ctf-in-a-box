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

export default async function SponsorStrip() {
  // Fail open like SiteFooter's own sponsor read: a Redis blip on this
  // cosmetic block must not break the landing page.
  const sponsors = await listSponsors().catch(() => []);
  if (sponsors.length === 0) return null;

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
            className="opacity-80 grayscale transition-all duration-150 hover:opacity-100 hover:grayscale-0"
          >
            {sponsor.logo ? (
              <img
                src={`/api/sponsors/logo/${sponsor.id}`}
                alt={`${sponsor.name} logo`}
                width={sponsor.logo.w}
                height={sponsor.logo.h}
                loading="lazy"
                decoding="async"
                className="h-6 w-auto max-w-[8rem] object-contain"
              />
            ) : (
              <span className="font-mono text-sm text-zinc-400">{sponsor.name}</span>
            )}
          </a>
        ))}
      </div>
      <Link href="/sponsors" className="font-mono text-xs text-[#8f8f9b] transition-colors hover:text-zinc-300">
        About sponsors
      </Link>
    </div>
  );
}
