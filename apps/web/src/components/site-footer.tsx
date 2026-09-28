// Footer shared by content routes. An ASYNC Server Component — it awaits
// getSite() internally — which means it MUST be called and awaited as a
// plain function (`await SiteFooter({ navLinks })`), never mounted as JSX
// (`<SiteFooter navLinks={...} />`): a nested async child suspends under
// `renderToStaticMarkup`, the same trap (site)/layout.tsx's own note
// documents for PhaseLine. See site-nav-parity.test.tsx's "every SiteFooter
// render site resolves its nav links" describe, which asserts every call
// site uses the call form.
//
// `navLinks` comes in as a PROP, resolved by the caller through
// `getNavLinks()`, exactly as the root layout feeds <SiteHeader>. It used to
// import `site.ts`'s static list directly, which meant an organizer's module
// rename appeared in the header and not the footer — the same links,
// disagreeing on every page. The prop is what keeps the two in step; don't
// reach for the static list here.

import Link from "next/link";
import { getSite, legalLinks, type NavLink } from "@/lib/site";
import { listSponsors } from "@/lib/sponsors-store";

// Layout (#474): a main block plus ONE bottom bar, groups separated by
// whitespace rather than dividers. It used to stack four rows, each drawing its
// own `border-t`, and read as four footers. Reading order is source order —
// wordmark, main nav, policy links, attribution, then the bottom bar's
// trademark notice and sponsors — which is also the phone column. From `md:`
// up the main block is a two-column grid placed by explicit row/column, never
// CSS `order`, so a screen reader still hears the source order.
// site-footer-layout.test.tsx pins all of this.
//
// `creditSponsors: false` is for the landing page, whose hero SponsorStrip
// already credits the sponsors from the same list; every other caller keeps
// the footer's text credit.

// Vertical padding on every link: `text-xs`/`text-sm` alone is a ~16px target,
// short of WCAG 2.5.8's 24px (or equivalent spacing).
const linkClass = "inline-block py-1 transition-colors";

export default async function SiteFooter({
  navLinks,
  creditSponsors = true,
}: {
  navLinks: NavLink[];
  creditSponsors?: boolean;
}) {
  // The footer renders on every route, error pages included — a Redis blip
  // on this cosmetic read must never take down a page whose actual content
  // loaded fine. Same independent-catch discipline admin-panel.tsx applies
  // to getAdminSettings().
  const [event, sponsors] = await Promise.all([getSite(), listSponsors().catch(() => [])]);
  const credited = creditSponsors ? sponsors : [];
  return (
    <footer className="relative mt-auto border-t border-white/[0.06]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#2563eb]/20 to-transparent" />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2 md:gap-x-10 md:gap-y-4">
          <div className="md:col-start-1 md:row-start-1">
            {/* The same terminal-prompt wordmark the header renders, from the
                same runtime event name — an organizer's rename must land in
                both or the two ends of every page disagree. This used to be
                the hardcoded `owasp-ctf` slug, which site-header.test.tsx
                forbids in the header and nothing forbade here. */}
            <p className="font-mono text-sm text-white">
              <span className="text-[#22c55e]">$</span> {event.name}
            </p>
            {(event.dates || event.location) && (
              <p className="mt-1 text-sm text-muted">
                {[event.dates, event.location].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>

          {/* Kept visible on phones: when the header collapses, this is the
              one wayfinding surface left on screen. */}
          <nav
            aria-label="Site"
            className="flex flex-wrap gap-x-5 gap-y-1 md:col-start-2 md:row-start-1 md:justify-end"
          >
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`${linkClass} text-sm text-zinc-400 hover:text-[#2563eb]`}
              >
                {link.label}
              </Link>
            ))}
            {event.discordUrl && (
              <a
                href={event.discordUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${linkClass} text-sm text-zinc-400 hover:text-[#2563eb]`}
              >
                Discord
              </a>
            )}
          </nav>

          {/* Policy routes sit in their own quieter line rather than in
              navLinks, which drives the header. The contact address rides
              along here so there is a way to reach the organizers from every
              page. */}
          <nav
            aria-label="Policies and contact"
            className="flex flex-wrap gap-x-5 gap-y-1 md:col-start-2 md:row-start-2 md:justify-end"
          >
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`${linkClass} text-xs text-muted hover:text-zinc-300`}
              >
                {link.label}
              </Link>
            ))}
            {event.contactEmail && (
              <a
                href={`mailto:${event.contactEmail}`}
                className={`${linkClass} text-xs text-muted hover:text-zinc-300`}
              >
                Contact
              </a>
            )}
          </nav>

          {/* OWASP attribution. The Project Policy asks that the links back to
              owasp.org, the project home page and the repo be prominent on
              any domain the project maintains — an event box runs on the
              organizer's own hostname, so this footer is that surface. Text
              and links, no logo image: the footer renders on every route, and
              sponsor-strip.tsx's note explains why an image here would cost
              every page load a fetch it doesn't need. Unconditional, unlike
              the sponsor and contact lines — there is no event on which this
              stops being true, so it never goes behind a disclosure. */}
          <p className="text-xs text-muted md:col-start-1 md:row-start-2">
            An{" "}
            <a
              href={event.owaspUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${linkClass} hover:text-zinc-300`}
            >
              OWASP Foundation
            </a>{" "}
            project ·{" "}
            <a
              href={event.owaspProjectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${linkClass} hover:text-zinc-300`}
            >
              Project page
            </a>{" "}
            ·{" "}
            <a
              href={event.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${linkClass} hover:text-zinc-300`}
            >
              Source
            </a>
          </p>
        </div>

        {/* The bottom bar: the footer's only inner divider. */}
        <div className="mt-8 flex flex-col gap-3 border-t border-white/[0.06] pt-5 text-xs text-muted md:flex-row md:items-baseline md:justify-between md:gap-10">
          <p>
            OWASP® is a registered trademark of the OWASP Foundation. OWASP does
            not endorse or recommend any product or service.
          </p>

          {/* Text only, no logos — see sponsor-strip.tsx for the logo row on
              the landing page. This renders on every route (the footer is
              shared), so a logo image here would cost every page load a fetch
              it doesn't need; a name and a link cost nothing extra. */}
          {credited.length > 0 && (
            <p className="md:text-right">
              Sponsored by{" "}
              {credited.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && " · "}
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow sponsored"
                    className={`${linkClass} hover:text-zinc-300`}
                  >
                    {s.name}
                  </a>
                </span>
              ))}
              {" · "}
              <Link href="/sponsors" className={`${linkClass} hover:text-zinc-300`}>
                About sponsors
              </Link>
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
