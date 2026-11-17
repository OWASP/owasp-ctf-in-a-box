// /how-to-play is a PLATFORM frame: the page header, the "good to know" and
// "how scoring works" cards, the links out to the rules and the leaderboard,
// and the organizer/Discord line. Everything that describes what a contestant
// actually DOES — the loop, the numbered steps, the worked example, the
// scoring paragraph — belongs to whichever modules the event enables and is
// pulled from their registry `guide` blocks. This page used to hardcode
// secure-development's whole workflow, so a quiz-only event handed contestants
// a guide to a game it wasn't running.
//
// This is a Server Component and must stay one. `ModuleGuide.steps` and
// `.example` are FUNCTIONS: they are called here, server-side, and only the
// resulting plain data is rendered. Never pass a ModuleGuide (or anything
// holding it) into a "use client" component — React's flight serializer
// rejects function-valued props. That is why guides are reached through the
// server-only `getModuleGuide` rather than off a ResolvedModule; see
// lib/modules.ts.
import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import ModuleCopy from "@/components/module-copy";
import PageHeader from "@/components/page-header";
import { joinAppNames, workedExampleVariant } from "@/lib/apps";
import { getEnabledApps } from "@/lib/enabled-apps";
import { moduleDefById, type GuideContext } from "@/lib/modules";
import { getEnabledModuleIds } from "@/lib/enabled-modules";
import { getModuleGuide, getResolvedModules } from "@/lib/resolved-modules";
import { getSite } from "@/lib/site";
import { getGithubOrg } from "@/lib/bootstrap-env";

// What the page is, in the live modules' own words. Read off the registry
// (guide copy is not organizer-overridable — only title/blurb are), behind
// the same cached live-set read the page body makes.
export async function generateMetadata(): Promise<Metadata> {
  const live = await getEnabledModuleIds();
  const event = await getSite();
  const metaDescription = [...live]
    .map((id) => moduleDefById(id)?.guide?.metaDescription)
    .filter(Boolean)
    .join(" ");
  return {
    title: "How to Play",
    description: metaDescription || `How to play ${event.name}.`,
  };
}

// The page lede when the event runs more than one guided module (or none):
// each module's own lede describes only its half, so the frame speaks for
// itself instead. A single-module event reads that module's lede verbatim.
const PLATFORM_LEDE =
  "New to the competition? Here's everything you need to get from signing in to your first points.";

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-md border border-white/10 bg-[#12121e] p-3 font-mono text-xs leading-relaxed text-zinc-300">
      {code}
    </pre>
  );
}

export default async function HowToPlayPage() {
  const event = await getSite();
  const enabledApps = await getEnabledApps();
  // Live facts handed to every module's copy, built once so two modules can't
  // disagree about how many targets the event has.
  const ctx: GuideContext = {
    appCount: enabledApps.length,
    appList: joinAppNames(enabledApps.map((a) => a.name)),
    // "" is a misconfiguration the setup wizard refuses and `doctor` flags; prose that interpolates the org is not guarded here (#386).
    githubOrg: getGithubOrg(),
    exampleVariant: workedExampleVariant(enabledApps),
  };

  // Registry order, organizer-resolved titles, and — crucially — plain data:
  // steps() and example() are invoked HERE, on the server. Nothing below this
  // line holds a function.
  const guides = (await getResolvedModules()).flatMap((module) => {
    const guide = getModuleGuide(module.id);
    if (!guide) return [];
    return [
      {
        id: module.id,
        title: module.title,
        lede: guide.lede,
        loop: guide.loop,
        callout: guide.callout,
        steps: guide.steps(ctx),
        example: guide.example?.(ctx),
        notes: guide.notes ?? [],
        scoring: guide.scoring,
        cta: guide.cta,
      },
    ];
  });

  // Zero modules with a guide is a valid event, not an error: the frame
  // renders on its own.
  const lede = guides.length === 1 ? guides[0].lede : PLATFORM_LEDE;
  // "Good to know" and "How scoring works" are the platform's cards; the
  // modules only supply their bullets and paragraphs, merged in registry
  // order so a two-module event gets one of each rather than two.
  //
  // Kept GROUPED by module rather than flattened: on a three-module event the
  // flat list read as nine anonymous bullets with three near-duplicates
  // ("Points are credited to the account…" once per module) and three
  // unlabeled scoring paragraphs — visible repetition that read as a bug
  // rather than as three modules each speaking for themselves (issue #200,
  // tier 4). Each group renders under its module's name once a second module
  // contributes; a single-module event keeps the unlabeled render, same rule
  // as the leaderboard's per-module headings.
  const noteGroups = guides
    .filter((g) => g.notes.length > 0)
    .map((g) => ({ id: g.id, title: g.title, notes: g.notes }));
  const scoring = guides.flatMap((g) => (g.scoring ? [{ id: g.id, title: g.title, body: g.scoring }] : []));
  const multiModule = guides.length > 1;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow="Getting Started" title="How to Play" description={lede} />

      {guides.map((guide) => (
        <Fragment key={guide.id}>
          {/* With one module the sections speak for themselves; with several,
              each module's block is headed by its organizer-resolved title so
              a contestant can tell which game a step belongs to. */}
          {guides.length > 1 && (
            <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {guide.title}
            </h2>
          )}

          {/* Workflow callout */}
          {guide.loop && (
            <div className="rounded-lg border border-[#2563eb]/30 bg-white/[0.06] p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-[var(--accent-blue-link)]">
                {guide.loop.kicker}
              </p>
              <p className="mt-2 font-mono text-sm text-zinc-300">
                {guide.loop.cycle.map((step, i) => (
                  <Fragment key={step}>
                    {i > 0 && <> <span className="text-zinc-600">→</span> </>}
                    {step}
                  </Fragment>
                ))}
              </p>
              <p className="mt-2 text-sm text-zinc-400">{guide.loop.note}</p>
            </div>
          )}

          {/* The module's own callout. For secure-development this is "Please
              use AI", which sits above the steps because it changes how you do
              step 4, and contestants who skim only the numbered list still
              see it. */}
          {guide.callout && (
            <div className="rounded-lg border border-[#14b8a6]/30 bg-[#14b8a6]/[0.06] p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-[#14b8a6]">
                {guide.callout.kicker}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                <ModuleCopy copy={guide.callout.body} />
              </p>
            </div>
          )}

          {/* Numbered steps */}
          <ol className="flex flex-col gap-4">
            {guide.steps.map((step, i) => (
              <li
                key={step.title}
                className="flex gap-4 rounded-lg border border-white/[0.06] bg-[#16162a] p-5"
              >
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-[#2563eb]/40 bg-white/[0.06] font-mono text-sm font-bold tabular-nums text-[var(--accent-blue-link)]">
                  {i + 1}
                </span>
                <div>
                  <h2 className="font-semibold text-white">{step.title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-400">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          {/* Worked example */}
          {guide.example && (
            <section className="flex flex-col gap-5" aria-labelledby={guide.example.anchor}>
              <div className="flex flex-col gap-3">
                <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#14b8a6]">
                  {guide.example.kicker}
                </p>
                <h2
                  id={guide.example.anchor}
                  className="text-2xl font-bold tracking-tight text-white sm:text-3xl"
                >
                  {guide.example.heading}
                </h2>
                <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
                  <ModuleCopy copy={guide.example.lede} />
                </p>
              </div>

              <ol className="flex flex-col gap-4">
                {guide.example.steps.map((step, i) => (
                  <li
                    key={step.title}
                    className="rounded-lg border border-white/[0.06] bg-[#16162a] p-5"
                  >
                    <div className="flex gap-4">
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-[#8f8f9b]/40 bg-[#8f8f9b]/10 font-mono text-sm font-bold tabular-nums text-[#8f8f9b]">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-white">{step.title}</h3>
                        <p className="mt-1 text-sm leading-relaxed text-zinc-400">{step.body}</p>
                        {step.code && <CodeBlock code={step.code} />}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>

              {guide.example.bonus && (
                <div className="rounded-lg border border-[#14b8a6]/30 bg-[#14b8a6]/[0.06] p-5">
                  <p className="text-xs font-medium uppercase tracking-wider text-[#14b8a6]">
                    {guide.example.bonus.kicker}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                    <ModuleCopy copy={guide.example.bonus.body} />
                  </p>
                </div>
              )}
            </section>
          )}
        </Fragment>
      ))}

      {/* Good-to-know */}
      {noteGroups.length > 0 && (
        <div className="flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
          <h2 className="font-semibold text-white">Good to know</h2>
          {noteGroups.map((group) => (
            <div key={group.id} className="flex flex-col gap-2">
              {multiModule && (
                <p className="text-[11px] uppercase tracking-wide text-muted">{group.title}</p>
              )}
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-zinc-400">
                {/* Index keys: two modules can word an identical caveat, and
                    the note text is therefore not a unique identity. */}
                {group.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Scoring note. The card is the platform's — it carries the links out
          to the rules and the leaderboard, which exist on every event — and
          each module contributes the paragraph that says how ITS points are
          earned, plus its own entry-point button. */}
      <div className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
        {scoring.length > 0 && <h2 className="font-semibold text-white">How scoring works</h2>}
        {scoring.map((paragraph) => (
          <div key={paragraph.id} className="flex flex-col gap-1">
            {multiModule && (
              <p className="text-[11px] uppercase tracking-wide text-muted">{paragraph.title}</p>
            )}
            <p className="text-sm leading-relaxed text-zinc-400">{paragraph.body}</p>
          </div>
        ))}
        <div className="flex flex-wrap gap-3 pt-1">
          {guides.map(
            (guide) =>
              guide.cta && (
                <Link
                  key={guide.id}
                  href={guide.cta.href}
                  className="rounded-md border border-[#2563eb]/70 bg-white/[0.06] px-4 py-2 text-sm font-medium text-[var(--accent-blue-link)] transition-colors hover:bg-white/[0.1]"
                >
                  {guide.cta.label}
                </Link>
              ),
          )}
          <Link
            href="/rules"
            className="rounded-md border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            Read the rules
          </Link>
          <Link
            href="/leaderboard"
            className="rounded-md border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            View the leaderboard
          </Link>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-muted">
        Stuck, or need an organizer? Find one at the {event.name} area
        {event.discordUrl && (
          <>
            , or ask in the{" "}
            <a
              href={event.discordUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ds-link"
            >
              CTF Discord
            </a>
          </>
        )}
        .
      </p>
    </div>
  );
}
