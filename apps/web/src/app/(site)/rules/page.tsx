// /rules is a PLATFORM frame with module contributions, on the same basis as
// /how-to-play: the platform owns the section headings and the rules that hold
// on any event whatsoever (team size, the code of conduct, prizes, organizer
// decisions), and each enabled module contributes the rules that name its own
// artifacts. "Submit every pull request from the account you signed in with"
// and "Revealing a hint deducts points" are not event-wide rules — they are
// secure-development's, and on a quiz-only event they describe a game that
// isn't running.
//
// Server Component, and must stay one: `ModuleRules` is a FUNCTION of the
// live target list, called here so only plain data is rendered. See
// lib/modules.ts for why it never rides on a ResolvedModule.
import type { Metadata } from "next";
import Link from "next/link";
import ModuleCopy from "@/components/module-copy";
import PageHeader from "@/components/page-header";
import { joinAppNames } from "@/lib/apps";
import { getEnabledApps } from "@/lib/enabled-apps";
import type { RulesContext } from "@/lib/modules";
import { getModuleRules, getResolvedModules } from "@/lib/resolved-modules";
import { getSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "Rules",
    description: `Competition rules for ${event.name}.`,
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

export default async function RulesPage() {
  const event = await getSite();
  const enabledApps = await getEnabledApps();
  const ctx: RulesContext = {
    appCount: enabledApps.length,
    appList: joinAppNames(enabledApps.map((a) => a.name)),
  };

  // Registry order. Each module's bullets are collected per section so the
  // platform decides where they land — module rules lead "Fair play" and
  // "Scoring & prizes" (they are the specific ones) and follow the platform's
  // in "Teams" and "Conduct" (which open with the event-wide statement).
  const contributions = (await getResolvedModules()).flatMap((module) => {
    const rules = getModuleRules(module.id);
    return rules ? [rules(ctx)] : [];
  });
  const fromModules = (section: "teams" | "fairPlay" | "conduct" | "scoring") =>
    contributions.flatMap((c) => c[section] ?? []).map((copy, i) => <ModuleCopy key={i} copy={copy} />);
  const fairPlayFromModules = fromModules("fairPlay");

  // Rules are React nodes rather than plain strings so a rule can link to the
  // document it defers to — a rule that just says a code of conduct applies is
  // not much use without a way to go read it.
  const sections: { heading: string; rules: React.ReactNode[] }[] = [
    {
      heading: "Teams",
      rules: [
        "Scoring is per team, and you need one before anything you solve counts. Compete solo with a one-click team of one, or in a team of up to four — create or join one from your profile after signing in with GitHub.",
        "Each person belongs to at most one team at a time.",
        // Stated once, for every module: three modules each restating this in
        // their own verb rendered as three near-identical adjacent bullets
        // (issue #200, tier 4). A module contributes a teams bullet only for
        // nuance this sentence cannot carry (secure-development's PR-author
        // credit, below).
        "Your GitHub login is your identity for scoring — everything you submit counts for the account you signed in with.",
        ...fromModules("teams"),
      ],
    },
    {
      // Every fair-play rule this event ships names a module's own artifacts
      // — its targets, its submissions, its abuse vectors — so the modules
      // write them. But the PRINCIPLES underneath (don't collude, don't
      // attack the platform) hold on any event whatsoever, and a module that
      // ships no `rules` block must not leave a CTF running with no
      // anti-collusion rule at all. These two generic bullets stand in when,
      // and only when, no enabled module has contributed any: on every event
      // that has one they render nothing, so they cost zero bytes on the
      // secure-development page.
      heading: "Fair play",
      rules:
        fairPlayFromModules.length > 0
          ? fairPlayFromModules
          : [
              "Submit your own work. Don't publish full solutions for others to copy during the event.",
              "Do not attack the scoring pipeline, the leaderboard, or other contestants. Report anything you find to an organizer instead of exploiting it.",
            ],
    },
    {
      heading: "Conduct",
      rules: [
        <>
          The{" "}
          <ExternalLink href={event.owaspCodeOfConductUrl}>OWASP Code of Conduct</ExternalLink>{" "}
          applies at all times.
          Harassment of any kind ends your event. See our{" "}
          <Link
            href="/code-of-conduct"
            className="ds-link"
          >
            code of conduct page
          </Link>{" "}
          for how to report a problem.
        </>,
        "Be excellent to the volunteers, organizers, and your fellow competitors.",
        ...fromModules("conduct"),
      ],
    },
    {
      heading: "Scoring & prizes",
      rules: [
        ...fromModules("scoring"),
        // The order rank.ts `compareStanding` and `compareTeamStanding` apply.
        "Individuals and teams are ranked by points; ties go to more items completed, then to whoever earned their last points first, in any module.",
        "Prizes are awarded to the top individuals and top teams overall. Winners must be present to claim.",
        "Organizer decisions on scoring disputes are final.",
      ],
    },
  ].filter((section) => section.rules.length > 0);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        eyebrow="The Fine Print"
        title="Rules"
        description="Keep the competition fair and the community welcoming. Breaking these can cost points or your spot in the event."
      />

      <div className="flex flex-col gap-6">
        {sections.map((section) => (
          <section
            key={section.heading}
            className="rounded-lg border border-white/[0.06] bg-[#16162a] p-6"
          >
            <h2 className="mb-4 text-lg font-semibold text-white">{section.heading}</h2>
            <ul className="flex flex-col gap-3">
              {section.rules.map((rule, i) => (
                <li key={i} className="flex gap-3 text-sm leading-relaxed text-zinc-400">
                  <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-[#2563eb]" />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="text-sm leading-relaxed text-muted">
        Stuck, or need an organizer? Find one at the {event.name} area
        {event.discordUrl && (
          <>
            , or ask in the{" "}
            <ExternalLink href={event.discordUrl}>CTF Discord</ExternalLink>
          </>
        )}
        . See also the{" "}
        <Link href="/terms" className="ds-link">
          terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="ds-link">
          privacy notice
        </Link>
        .
      </p>
    </div>
  );
}
