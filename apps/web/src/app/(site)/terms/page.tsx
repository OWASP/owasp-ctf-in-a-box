// Participation terms for the CTF specifically. This is not a general site
// Terms of Service — OWASP publishes no ToS, and its General Disclaimer is the
// governing document, linked below. What's here is limited to what taking part
// in this competition actually commits you to.
//
// A PLATFORM frame with module contributions, like /rules and /faq. Every
// participation term this kit has written names a module's own artifacts —
// what you submit, where you may test, what a point is worth — so the modules
// own them, and the platform keeps the two that hold on any event (prizes,
// disputes) plus a fallback list per section.
//
// The scope section is why this page mattered most: with no module owning it,
// an event with no targets rendered "Your authorization to test covers the 0
// challenge targets only: ," — a legal scope clause that authorized nothing,
// on the page that tells contestants what they are permitted to attack. The
// fallbacks below exist so that section can never be empty either.
//
// Server Component, and must stay one: `ModuleTerms` is a FUNCTION of the live
// event facts, called here so only plain data is rendered.

import type { Metadata } from "next";
import Link from "next/link";
import ModuleCopy from "@/components/module-copy";
import PageHeader from "@/components/page-header";
import { joinAppNames } from "@/lib/apps";
import { getEnabledApps } from "@/lib/enabled-apps";
import type { Copy, OrgContext } from "@/lib/modules";
import { getModuleTerms, getResolvedModules } from "@/lib/resolved-modules";
import { getSite } from "@/lib/site";
import { getGithubOrg } from "@/lib/bootstrap-env";

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "Terms",
    // Module-agnostic, same reason as /faq's: the clauses below come from
    // whichever modules the event enables, so the description cannot name one
    // (it used to say "secure development CTF" on every event).
    description:
      `Participation terms for ${event.name}: eligibility, testing scope, submissions, scoring, and prizes.`,
  };
}

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="ds-link"
  >
    {children}
  </a>
);

// Stand-ins for an event whose modules contribute no terms of their own. They
// render only when NO enabled module contributed to that section, so on every
// event that has one they cost nothing — the same shape as /rules' fair-play
// fallback. Deliberately generic: they must hold whatever the event turns out
// to be, which is exactly what makes them a floor rather than a default.
const FALLBACK: Record<"eligibility" | "scope" | "submissions", Copy[]> = {
  eligibility: [
    "You need an account on this site. Your account is your identity for scoring, so take part from the account you sign in with. Points are credited to that account and cannot be moved between accounts afterwards.",
    "Organizers and anyone who worked on the competition's content or its scoring may compete for fun but are not eligible for prizes.",
  ],
  scope: [
    "This event authorizes no testing of any system. Nothing here should be read as permission to attack anything.",
    "Explicitly out of scope: the scoring pipeline, the leaderboard, this website, the CTF Discord, and other contestants' accounts or machines.",
    "Found a real security bug in this site or in the scoring pipeline? That is genuinely useful. Report it to an organizer rather than exploiting it. Doing so will not cost you anything.",
  ],
  submissions: [
    "Submit your own work. Passing off another contestant's work as your own is not allowed.",
    "Don't publish full solutions for others to copy while the event is running. Afterwards, write up whatever you like.",
  ],
};

export default async function TermsPage() {
  const event = await getSite();
  const enabledApps = await getEnabledApps();
  const ctx: OrgContext = {
    appCount: enabledApps.length,
    appList: joinAppNames(enabledApps.map((a) => a.name)),
    // "" is a misconfiguration the setup wizard refuses and `doctor` flags; prose that interpolates the org is not guarded here (#386).
    githubOrg: getGithubOrg(),
  };

  const contributions = (await getResolvedModules()).flatMap((module) => {
    const terms = getModuleTerms(module.id);
    return terms ? [terms(ctx)] : [];
  });
  const fromModules = (section: "eligibility" | "scope" | "submissions" | "scoring") =>
    contributions.flatMap((c) => c[section] ?? []);
  const render = (items: Copy[]): React.ReactNode[] =>
    items.map((copy, i) => <ModuleCopy key={i} copy={copy} />);
  // Module bullets, or the floor when there are none.
  const orFallback = (section: "eligibility" | "scope" | "submissions") => {
    const own = fromModules(section);
    return render(own.length > 0 ? own : FALLBACK[section]);
  };

  const sections: { heading: string; items: React.ReactNode[] }[] = [
    { heading: "Eligibility", items: orFallback("eligibility") },
    { heading: "Scope of authorized testing", items: orFallback("scope") },
    { heading: "Your submissions", items: orFallback("submissions") },
    {
      heading: "Scoring and prizes",
      items: [
        ...render(fromModules("scoring")),
        "Prizes go to the top individuals and top teams overall. You must be present at the closing ceremony to claim.",
        "Organizer decisions on scoring disputes are final.",
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        eyebrow="The Fine Print"
        title="Terms"
        description="What taking part in this competition commits you to. Short, and specific to the CTF. The OWASP Foundation's own policies govern everything beyond it."
      />

      <section className="rounded-lg border border-white/[0.06] bg-[#16162a] p-6">
        <h2 className="mb-2 text-lg font-semibold text-white">What governs what</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          This page covers participation in the CTF. Beyond it, the OWASP Foundation&apos;s{" "}
          <ExternalLink href={event.owaspDisclaimerUrl}>General Disclaimer</ExternalLink> applies
          to this site and its content, including that everything here is provided without
          warranty of service or accuracy. Conduct is governed by the{" "}
          <Link
            href="/code-of-conduct"
            className="ds-link"
          >
            code of conduct
          </Link>
          , and what this site stores about you is described in the{" "}
          <Link href="/privacy" className="ds-link">
            privacy notice
          </Link>
          . Competition mechanics live in the{" "}
          <Link href="/rules" className="ds-link">
            rules
          </Link>
          .
        </p>
      </section>

      <div className="flex flex-col gap-6">
        {sections.map((section) => (
          <section
            key={section.heading}
            className="rounded-lg border border-white/[0.06] bg-[#16162a] p-6"
          >
            <h2 className="mb-4 text-lg font-semibold text-white">{section.heading}</h2>
            <ul className="flex flex-col gap-3">
              {section.items.map((item, i) => (
                <li key={i} className="flex gap-3 text-sm leading-relaxed text-zinc-400">
                  <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-[#2563eb]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="text-sm leading-relaxed text-muted">
        Questions about any of this? Ask an organizer at the {event.name} area
        {event.discordUrl && (
          <>
            {" "}or in the{" "}
            <ExternalLink href={event.discordUrl}>CTF Discord</ExternalLink>
          </>
        )}
        {event.contactEmail && (
          <>
            , or email{" "}
            <a href={`mailto:${event.contactEmail}`} className="ds-link font-mono">
              {event.contactEmail}
            </a>
          </>
        )}
        .
      </p>
    </div>
  );
}
