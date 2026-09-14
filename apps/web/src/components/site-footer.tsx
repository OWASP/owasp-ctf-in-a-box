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

export default async function SiteFooter({ navLinks }: { navLinks: NavLink[] }) {
  // The footer renders on every route, error pages included — a Redis blip
  // on this cosmetic read must never take down a page whose actual content
  // loaded fine. Same independent-catch discipline admin-panel.tsx applies
  // to getAdminSettings().
  const [event, sponsors] = await Promise.all([getSite(), listSponsors().catch(() => [])]);
  return (
    <footer className="relative mt-auto border-t border-white/[0.06]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#2563eb]/20 to-transparent" />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-mono text-sm text-white">
              <span className="text-[#22c55e]">$</span> owasp-ctf
            </p>
            {(event.dates || event.location) && (
              <p className="mt-1 text-sm text-muted">
                {[event.dates, event.location].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-zinc-400 transition-colors hover:text-[#2563eb]"
              >
                {link.label}
              </Link>
            ))}
            {event.discordUrl && (
              <a
                href={event.discordUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-400 transition-colors hover:text-[#2563eb]"
              >
                Discord
              </a>
            )}
          </nav>
        </div>

        {/* Policy routes sit in their own quieter row rather than in navLinks,
            which drives the header. The contact address rides along here so
            there is a way to reach the organizers from every page. */}
        <nav
          aria-label="Policies and contact"
          className="flex flex-wrap gap-x-5 gap-y-2 border-t border-white/[0.06] pt-5"
        >
          {legalLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-xs text-muted transition-colors hover:text-zinc-300"
            >
              {link.label}
            </Link>
          ))}
          {event.contactEmail && (
            <a
              href={`mailto:${event.contactEmail}`}
              className="text-xs text-muted transition-colors hover:text-zinc-300"
            >
              Contact
            </a>
          )}
        </nav>

        {/* Text only, no logos — see sponsor-strip.tsx for the logo row on
            the landing page. This renders on every route (the footer is
            shared), so a logo image here would cost every page load a fetch
            it doesn't need; a name and a link cost nothing extra. */}
        {sponsors.length > 0 && (
          <p className="border-t border-white/[0.06] pt-5 text-xs text-muted">
            Supported by{" "}
            {sponsors.map((s, i) => (
              <span key={s.id}>
                {i > 0 && " · "}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow sponsored"
                  className="transition-colors hover:text-zinc-300"
                >
                  {s.name}
                </a>
              </span>
            ))}
            {" · "}
            <Link href="/sponsors" className="transition-colors hover:text-zinc-300">
              About sponsors
            </Link>
          </p>
        )}
      </div>
    </footer>
  );
}
