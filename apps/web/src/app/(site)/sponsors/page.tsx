// The sponsors credit page (issue #405): logo, name, blurb and link per
// sponsor, grouped by tier. Linked from site-footer.tsx's own row, NOT
// navLinks — sponsors do not belong in contestant navigation.
//
// The disclaimer below is FIXED COPY, hardcoded here — not an admin field,
// not an override. An organizer who could edit it could sell it (see the
// sponsors ADR in docs/decisions.md), so the one thing this page says about
// OWASP's relationship to its sponsors is not something a runtime setting
// can touch.

import type { Metadata } from "next";
import { getSite } from "@/lib/site";
import { listSponsors, tierRank, type Sponsor } from "@/lib/sponsors-store";
import PageHeader from "@/components/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "Sponsors",
    description: `Organizations supporting ${event.name}.`,
  };
}

const TIER_LABEL: Record<Sponsor["tier"], string> = {
  gold: "Gold",
  silver: "Silver",
  community: "Community",
};

function groupByTier(sponsors: Sponsor[]): [Sponsor["tier"], Sponsor[]][] {
  const groups = new Map<Sponsor["tier"], Sponsor[]>();
  for (const sponsor of sponsors) {
    const list = groups.get(sponsor.tier) ?? [];
    list.push(sponsor);
    groups.set(sponsor.tier, list);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => tierRank(a) - tierRank(b));
}

export default async function SponsorsPage() {
  // Fails open to an empty list on a Redis blip, same as the footer/strip —
  // this page has no organizer-only content to protect either way.
  const sponsors = await listSponsors().catch(() => []);
  const groups = groupByTier(sponsors);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="Sponsors" title="Sponsors" description="Organizations funding this event." />

      <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] px-5 py-4">
        <p className="text-sm leading-relaxed text-zinc-400">
          OWASP does not endorse sponsors, their products, or their services. Sponsors fund this
          event. They have no influence over challenge content, scoring, or results.
        </p>
      </div>

      {sponsors.length === 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-[#16162a] px-6 py-10 text-center">
          <p className="text-sm text-zinc-400">This event has no sponsors listed yet.</p>
        </div>
      ) : (
        groups.map(([tier, rows]) => (
          <section key={tier} className="flex flex-col gap-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.25em] text-[#8f8f9b]">
              {TIER_LABEL[tier]}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {rows.map((sponsor) => (
                <a
                  key={sponsor.id}
                  href={sponsor.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow sponsored"
                  className="ds-card flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-[#16162a] p-6 transition-colors hover:border-[#2563eb]/45"
                >
                  {sponsor.logo && (
                    <img
                      src={`/api/sponsors/logo/${sponsor.id}`}
                      alt={`${sponsor.name} logo`}
                      width={sponsor.logo.w}
                      height={sponsor.logo.h}
                      loading="lazy"
                      decoding="async"
                      className="h-10 w-auto max-w-[12rem] object-contain"
                    />
                  )}
                  <h3 className="text-lg font-bold text-white">{sponsor.name}</h3>
                  {sponsor.blurb && <p className="text-sm leading-relaxed text-zinc-400">{sponsor.blurb}</p>}
                </a>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
