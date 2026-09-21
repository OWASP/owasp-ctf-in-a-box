// Central site config: event facts and primary navigation.
// Keep route copy in one place so the header, footer, and metadata stay in sync.

import { cache } from "react";
import { getAdminSettingsSnapshot } from "@/lib/enabled-modules";
import { DEFAULT_EVENT_IDENTITY, type EventIdentityOverrides } from "@/lib/event-identity";
import { formatDateRange } from "@/lib/event-dates";
import { SECURE_AGENT_PLAYBOOK_URL } from "@/lib/modules";
import type { NavEntry, NavGroup, NavLink } from "@/lib/site-nav";

// Re-exported verbatim so every existing consumer of these off `@/lib/site`
// keeps working unchanged — see `site-nav.ts` for why they live there now
// (a Client Component needs `isNavGroup` as a value without pulling in this
// file's `enabled-modules`/`server-only` chain).
export { isNavGroup } from "@/lib/site-nav";
export type { NavLink, NavGroup, NavEntry } from "@/lib/site-nav";

export type Site = {
  name: string;
  theme: string;
  dates: string;
  location: string;
  ctfStartsAt: string | null;

  // Live contestant support during the event: scoring questions, stuck runs,
  // organizer announcements. Sourced from the organizer's stored identity (or
  // the spec default) — the header, hero, rules, how-to-play, 404, and FAQ all
  // funnel contestants here. "" (the default) means pages hide their Discord
  // links and mentions entirely, same pattern as contactEmail below.
  discordUrl: string;
  // The CTF team's own inbox: the one address on this site that reaches the
  // organizers rather than the Foundation. Use it for anything that
  // needs a private, written channel and shouldn't go in a public Discord.
  // "" (the default) means pages hide their contact-email lines.
  contactEmail: string;
  // OWASP's own project: OWASP-grounded procedures an AI agent follows to do
  // security engineering work. The recommended way to point an agent at a target.
  // Defined in `modules.ts` (secure-development's registry copy links to it,
  // and that file cannot import this one without a cycle) and re-exported
  // here so pages keep reading it off `Site`, as they always have.
  secureAgentPlaybookUrl: string;

  // OWASP attribution for the box's own domain. The Project Policy asks that
  // OWASP branding — links back to owasp.org, to the project home page and to
  // the repo — be prominent on any domain a project maintains, and an event
  // box on an organizer's own hostname is exactly that. Constants, not
  // organizer overrides: an organizer renames their event, never the
  // Foundation.
  owaspUrl: string;
  owaspProjectUrl: string;
  sourceUrl: string;

  // Governing policies. This site publishes short, specific notices and defers
  // to these as the authoritative documents — we don't restate them.
  owaspPrivacyUrl: string;
  owaspCodeOfConductUrl: string;
  // OWASP publishes no Terms of Service; the General Disclaimer is the analogue.
  owaspDisclaimerUrl: string;
  // As published on the OWASP privacy policy — note .com, not .org.
  privacyContactEmail: string;
};

/** Pure merge: the organizer's stored identity over the spec defaults, plus
 *  the two identity facts derived from the admin scoring schedule rather than
 *  stored themselves — `dates` (the landing page's dates line) and
 *  `ctfStartsAt` (the countdown's target). `schedule` is `null` when there is
 *  no settings snapshot to read (fail-open); either bound inside it may
 *  independently be `null` (no override stored) — `formatDateRange` treats a
 *  missing/unparseable bound as absent rather than throwing. */
export function resolveSite(
  overrides: EventIdentityOverrides | null,
  schedule: { scoringStartsAt: string | null; scoringEndsAt: string | null } | null,
): Site {
  const o = overrides ?? {};
  return {
    // `||`, not `??`, for eventName ONLY: an empty string is a valid "no
    // override" state for the other four fields (each hides its own UI
    // element when blank), but an empty <title>/headline is never desirable.
    // The app's own write path already guards against writing "" here
    // (validation), so this only matters for a hand-run
    // `HSET ctf:admin:settings eventName ""`.
    name: o.eventName || DEFAULT_EVENT_IDENTITY.eventName,
    theme: o.eventTheme ?? DEFAULT_EVENT_IDENTITY.eventTheme,
    location: o.eventLocation ?? DEFAULT_EVENT_IDENTITY.eventLocation,
    contactEmail: o.eventContact ?? DEFAULT_EVENT_IDENTITY.eventContact,
    discordUrl: o.eventDiscord ?? DEFAULT_EVENT_IDENTITY.eventDiscord,
    dates: formatDateRange(schedule?.scoringStartsAt ?? null, schedule?.scoringEndsAt ?? null),
    ctfStartsAt: schedule?.scoringStartsAt ?? null,
    secureAgentPlaybookUrl: SECURE_AGENT_PLAYBOOK_URL,
    owaspUrl: "https://owasp.org/",
    owaspProjectUrl: "https://owasp.org/projects/ctf-in-a-box",
    sourceUrl: "https://github.com/OWASP/owasp-ctf-in-a-box",
    owaspPrivacyUrl: "https://policy.owasp.org/operational/privacy",
    owaspCodeOfConductUrl: "https://policy.owasp.org/operational/code-of-conduct",
    owaspDisclaimerUrl: "https://policy.owasp.org/operational/general-disclaimer",
    privacyContactEmail: "privacy@owasp.com",
  };
}

/** The event's identity for this request: one cached read of the settings
 *  snapshot (shared with the module nav — no second HGETALL), failing open to
 *  the defaults when Redis is unreachable (spec §2). Server-only by
 *  transitivity (`enabled-modules`); Client Components take these values as
 *  props from a server ancestor. */
export const getSite = cache(async (): Promise<Site> => {
  const settings = await getAdminSettingsSnapshot();
  return resolveSite(settings?.eventIdentity ?? null, {
    scoringStartsAt: settings?.scoringStartsAt ?? null,
    scoringEndsAt: settings?.scoringEndsAt ?? null,
  });
});

// Platform-level pages that exist regardless of which modules are enabled.
// Module-owned entries (e.g. Challenges) are NOT listed here — they're
// spliced in from the module registry below, so a module's nav entry
// appears if and only if that module is enabled (module contract §5.4).
const leadingNavLinks: NavLink[] = [{ href: "/how-to-play", label: "How to Play" }];
const trailingNavLinks: NavLink[] = [
  { href: "/rules", label: "Rules" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/faq", label: "FAQ" },
];

/** Pure builder for the resolved-module nav: platform links flank the live
 *  module links, in that order, with each module link's label replaced by the
 *  organizer's EXPLICIT rename when there is one — see resolved-modules.ts
 *  for where the modules come from. A module with no `nav` entry contributes
 *  nothing. Pure — no I/O — so it's testable on its own with plain object
 *  literals, independent of the module registry.
 *
 *  `titleOverride`, deliberately, not `title`: `title` is always set (it
 *  falls back to the registry `displayName`), so reading it here renamed the
 *  nav on every event that had never touched the admin panel —
 *  secure-development's nav label is "Challenges" but its display name is
 *  "Secure Development". With no override the registry's own nav label
 *  stands, unchanged; with one, the organizer's name wins. */
export function buildNavLinks(
  modules: readonly { nav?: NavLink; titleOverride?: string }[],
): NavLink[] {
  const moduleLinks = modules
    .filter((m) => m.nav)
    .map((m) => ({ href: m.nav!.href, label: m.titleOverride || m.nav!.label }));
  return [...leadingNavLinks, ...moduleLinks, ...trailingNavLinks];
}

/** Same platform link order as `buildNavLinks`, but collapses module nav
 *  entries into a single "Challenges" dropdown once there are two or more of
 *  them — a fourth module would otherwise mean a fourth top-level header
 *  entry. Pure — no I/O — for the same reason `buildNavLinks` is.
 *
 *  - **2+ modules with a nav entry**: one `NavGroup` labelled the literal
 *    string "Challenges", whose items carry each module's `title` (the
 *    organizer's override, or the registry `displayName`) — NOT its
 *    `nav.label`. `nav.label` names the destination PAGE ("Challenges"); a
 *    dropdown called "Challenges" containing an item also called "Challenges"
 *    is nonsense, so the child must read the module's own name instead. An
 *    organizer rename still flows in: with an override, `title` IS it.
 *  - **Exactly 1 module**: falls back to `buildNavLinks` verbatim — a plain
 *    `NavLink` labelled `titleOverride || nav.label`, byte-for-byte the same
 *    single-module header this kit has always rendered. Reading `title` here
 *    instead is the accidental-rename bug `buildNavLinks` itself guards
 *    against (see its own doc comment) — don't reintroduce it by routing the
 *    1-module case through the grouped label instead.
 *  - **0 modules**: contributes nothing, same as `buildNavLinks`. */
export function buildNavGroups(
  modules: readonly { nav?: NavLink; title: string; titleOverride?: string }[],
): NavEntry[] {
  const withNav = modules.filter(
    (m): m is typeof m & { nav: NavLink } => m.nav !== undefined,
  );
  if (withNav.length < 2) {
    return buildNavLinks(modules);
  }
  const group: NavGroup = {
    label: "Challenges",
    items: withNav.map((m) => ({ href: m.nav.href, label: m.title })),
  };
  return [...leadingNavLinks, group, ...trailingNavLinks];
}

// Policy routes. Deliberately kept out of `navLinks` — these belong in the
// footer's secondary row, not the header nav.
export const legalLinks: NavLink[] = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/code-of-conduct", label: "Code of Conduct" },
];
