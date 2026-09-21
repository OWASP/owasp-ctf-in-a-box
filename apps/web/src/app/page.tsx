// The landing page is a PITCH with one door, not documentation (DESIGN.md).
//
// Three visitors, in priority order: a contestant mid-event who needs the way
// back to their board; a signed-out contestant who needs one obvious action
// for the event's CURRENT phase; an evaluator deciding in ninety seconds
// whether to run this kit for their group. Grading rules — cooldowns,
// normalization, case-sensitivity — live in How to play and at the point of
// play, never here.
//
// This is a Server Component and must stay one. `ModuleHome.intro` is a
// FUNCTION: it is called here, server-side, and only the resulting strings
// are rendered. Never pass a ModuleHome (or anything holding it) into a
// "use client" component — React's flight serializer rejects function-valued
// props. That is also why `home` is reached via the server-only
// `getModuleHome` rather than off a ResolvedModule; see lib/modules.ts.
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import EventCountdown from "@/components/event-countdown";
import HeroCta from "@/components/hero-cta";
import OAuthErrorNotice from "@/components/oauth-error-notice";
import PhaseLine, { resolvePhase, type EventPhase } from "@/components/phase-line";
import SiteFooter from "@/components/site-footer";
import SponsorStrip from "@/components/sponsor-strip";
import { auth } from "@/lib/auth";
import { joinAppNames } from "@/lib/apps";
import { getEnabledApps, getEnabledTotals } from "@/lib/enabled-apps";
import { getChallengeCatalog } from "@/lib/challenges";
import { listChallenges } from "@/lib/classic-store";
import { listQuestions } from "@/lib/quiz-store";
import { getFoldedLeaderboard } from "@/lib/leaderboard/folded";
import { DOCS_URL, type HomeContext } from "@/lib/modules";
import { getEnabledModuleIds } from "@/lib/enabled-modules";
import { getModuleHome, getNavLinks, getResolvedModules } from "@/lib/resolved-modules";
import { hasTeam } from "@/lib/team-store";
import { sanitizeNext } from "@/lib/post-signin";
import { getSite } from "@/lib/site";

/** The one action this visitor should take, by auth × team × phase. */
function primaryAction(
  phase: EventPhase | null,
  signedIn: boolean,
  hasTeam: boolean,
  firstBoard: { href: string; label: string } | null,
): { label: string; href?: string; signIn?: boolean; callbackURL?: string } {
  if (phase === "results") return { label: "See the final standings", href: "/leaderboard" };
  if (phase === "frozen") return { label: "See the standings", href: "/leaderboard" };
  if (!signedIn) {
    return phase === "registration"
      ? { label: "Sign in and register", signIn: true, callbackURL: "/profile#team" }
      : { label: "Sign in and play", signIn: true, callbackURL: firstBoard?.href ?? "/profile" };
  }
  if (!hasTeam) return { label: "Join a team", href: "/profile#team" };
  // The board CTA's own label carries its verb ("Browse targets", "Take the
  // quiz") — prefixing "Open" produced "Open Browse targets", caught on the
  // deployed branch's first screenshot pass.
  if (firstBoard) return { label: firstBoard.label, href: firstBoard.href };
  return { label: "See the standings", href: "/leaderboard" };
}

/** Next gives every searchParams value as `string | string[] | undefined` —
 *  a repeated `?error=x&error=y` arrives as an array, which would reach
 *  `FRIENDLY_COPY[error]` as an object rather than a matching key (CodeRabbit
 *  finding). The first value wins, matching how a browser/GitHub would only
 *  ever set one in practice. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The landing page: the event pitch, the module sections, the viewer's next
 * action, and — once scoring could have started — the top of the live board
 * read from the shared 10 s fold memo.
 */
export default async function Home({
  searchParams,
}: {
  /** GitHub's OAuth callback error, when the authorize step fails — a
   *  suspended/deleted OAuth app, a cancelled prompt, or a redirect URI it
   *  doesn't recognize. better-auth's own error redirect (and, for the
   *  suspended-app case, GitHub itself) lands back on `/` with these.
   *  `error_description` is read here but deliberately never rendered —
   *  see `OAuthErrorNotice` — and `next` is the failed sign-in's own
   *  destination, round-tripped through `oauthErrorCallbackURL`. */
  searchParams?: Promise<{
    error?: string | string[];
    error_description?: string | string[];
    next?: string | string[];
  }>;
} = {}) {
  const event = await getSite();
  const params = await searchParams;
  const oauthError = firstOf(params?.error) ?? null;
  // Re-validated here with the SAME rule the outgoing leg used
  // (`sanitizeNext`) — this arrives through an attacker-influenceable query
  // string, so it is never trusted merely because `oauthErrorCallbackURL`
  // wrote it. `error_description` is intentionally not read past this point:
  // it is arbitrary provider text and must never reach the rendered page
  // (CodeRabbit pre-merge finding, "Secrets & Challenge Data In Logs").
  const oauthRetryDestination = sanitizeNext(firstOf(params?.next));
  const catalog = await getChallengeCatalog();
  // The live target list, read once per request (both cache()-wrapped on the
  // same settings snapshot every other live-set question here shares) — see
  // lib/enabled-apps.ts.
  const [enabledApps, enabledTotals] = await Promise.all([getEnabledApps(), getEnabledTotals()]);
  const sortedApps = [...enabledApps].sort((a, b) => a.name.localeCompare(b.name));

  const appList = joinAppNames(enabledApps.map((a) => a.name));
  const topByPoints = [...enabledApps].sort((a, b) => b.maxPoints - a.maxPoints).slice(0, 2);
  const topAppsList = joinAppNames(topByPoints.map((a) => a.name));

  // One snapshot for every live-set question on this page (CodeRabbit round 1
  // finding A) — `getEnabledModuleIds()` is `cache()`-memoized per request,
  // so this and the quiz/classic reads below share the same underlying
  // settings read regardless; reading `.has()` off ONE local instead of
  // awaiting `isModuleLive` three times just makes that a snapshot in the
  // code, not only in the cache.
  const live = await getEnabledModuleIds();
  const secureDevelopment = live.has("secure-development");

  // Live facts handed to every module's copy, built once so two modules can't
  // disagree about how many targets the event has.
  const ctx: HomeContext = {
    appCount: enabledApps.length,
    appList,
    topAppsList,
    // The runtime enabled-target subset, never the scorer's catalogue total
    // (CodeRabbit round 1): getChallengeCatalog() returns every rubric
    // target, not the app's secureDevTargets subset, so catalog.total can
    // overcount when targets are narrowed.
    totalChallenges: enabledTotals.challenges,
  };

  // Registry order, organizer-resolved titles, plain strings only — see the
  // header comment for why intro() is invoked here.
  const resolvedModules = await getResolvedModules();
  const sections = resolvedModules.map((module) => {
    const home = getModuleHome(module.id);
    return {
      id: module.id,
      title: module.title,
      tagline: home?.tagline ?? null,
      intro: home ? home.intro(ctx) : module.blurb,
      cta: home?.cta ?? null,
      extra: home?.extra ?? null,
    };
  });

  const taglines = sections
    .map((s) => s.tagline)
    .filter((t): t is string => Boolean(t))
    .join(" · ");

  // Per-board item counts for the game cards. Quiz and classic are one read
  // each and only when enabled; a failed read drops the count line, never the
  // card.
  const quizLive = live.has("quiz");
  const classicLive = live.has("classic");
  const [quizCount, classicCount] = await Promise.all([
    quizLive ? listQuestions().then((q) => q.length).catch(() => null) : Promise.resolve(null),
    classicLive ? listChallenges().then((c) => c.length).catch(() => null) : Promise.resolve(null),
  ]);
  const countFor = (id: string): string | null => {
    if (id === "secure-development")
      return `${ctx.totalChallenges} challenges · ${ctx.appCount} ${ctx.appCount === 1 ? "app" : "apps"}`;
    if (id === "quiz") return quizCount === null ? null : `${quizCount} ${quizCount === 1 ? "question" : "questions"}`;
    if (id === "classic") return classicCount === null ? null : `${classicCount} ${classicCount === 1 ? "flag" : "flags"}`;
    return null;
  };

  // Visitor state for the single primary action. The phase comes from the
  // same resolver the phase line uses, so the hero and the strip can never
  // disagree; the team read only runs signed-in.
  const [phaseInfo, session, navLinks] = await Promise.all([
    resolvePhase(),
    auth.api.getSession({ headers: await headers() }),
    getNavLinks(),
  ]);
  // Called and awaited, not mounted as `<SiteFooter navLinks={navLinks} />`:
  // since `site-footer.tsx` became an async Server Component (config v2, PR
  // 1b), mounting it as a nested JSX element suspends under
  // `renderToStaticMarkup` — the same trap `(site)/layout.tsx` documents for
  // `PhaseLine`.
  const footer = await SiteFooter({ navLinks });
  const sponsorStrip = await SponsorStrip();
  const login = (session?.user as { login?: string } | undefined)?.login ?? null;
  // hasTeam, not getViewerTeam truthiness: hasTeam is the SAME fail-open,
  // mock-mode-aware answer the submission gates use, so the hero can never
  // say "Join a team" to someone whose submissions would score (a Redis
  // blip, or a dev stack with team writes off).
  const team = login ? await hasTeam(login) : false;
  const firstBoard = sections.find((s) => s.cta)?.cta ?? null;
  const action = primaryAction(phaseInfo?.phase ?? null, Boolean(login), team, firstBoard);

  // The live strip: the top of the same standings the leaderboard shows —
  // literally the same fold, read through the 10 s cross-request memo the
  // leaderboard page uses (issue #444), so a room refreshing the landing page
  // and the board together costs one fold, not two per viewer.
  // Only once there could be something to show, and a failed read hides the
  // strip — the pitch must not 500 because Redis blinked.
  let topRows: { key: string; name: string; points: number }[] = [];
  // Whether the rows are teams or individuals — the strip's kicker says
  // WHICH, because three bare names mean nothing to a first-time visitor.
  let topRowsAreTeams = false;
  if (phaseInfo && phaseInfo.phase !== "registration") {
    try {
      const data = await getFoldedLeaderboard();
      topRowsAreTeams = data.teams.length > 0;
      topRows = topRowsAreTeams
        ? data.teams.slice(0, 3).map((t) => ({ key: t.slug, name: t.name, points: t.points }))
        : data.entries.slice(0, 3).map((e) => ({ key: e.login, name: e.login, points: e.points }));
    } catch {
      topRows = [];
    }
  }

  const gamesGrid =
    sections.length >= 3 ? "md:grid-cols-3" : sections.length === 2 ? "md:grid-cols-2" : "";

  // Awaited, not mounted: an async child suspends under renderToStaticMarkup
  // (the landing test suites render this page statically).
  const phaseLine = await PhaseLine();

  return (
    <div className="flex flex-1 flex-col">
      {phaseLine}

      {/* Hero: the event, its games in one breath, ONE action. */}
      <div className="border-b border-white/[0.09] bg-[#1a1a2e]">
        <main id="main-content" className="mx-auto flex w-full max-w-5xl flex-col items-start gap-6 px-6 py-16 sm:py-24">
          {/* OWASP brand mark — four of the six targets are OWASP projects
              and the event format comes from the OWASP-CTF work. */}
          <Image
            src="/owasp-logo.png"
            alt="OWASP"
            width={200}
            height={69}
            priority
            className="invert"
          />
          {taglines && (
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#14b8a6]">{taglines}</p>
          )}
          <h1 className="max-w-3xl text-balance text-5xl font-black tracking-tight text-white sm:text-7xl">
            {event.name}
          </h1>
          {(event.dates || event.location) && (
            <p className="font-mono text-sm text-[#8f8f9b]">
              {event.dates}
              {event.dates && event.location && " · "}
              {event.location}
            </p>
          )}

          {sponsorStrip}

          {phaseInfo?.phase === "registration" && event.ctfStartsAt && (
            <EventCountdown startsAt={event.ctfStartsAt} />
          )}

          {oauthError && (
            <OAuthErrorNotice error={oauthError} callbackURL={oauthRetryDestination} />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-5">
            <HeroCta
              label={action.label}
              href={action.href}
              signIn={action.signIn}
              callbackURL={action.callbackURL}
            />
            <Link href="/how-to-play" className="ds-link text-sm">
              How it works
            </Link>
          </div>

          {/* The top of the board, in the hero. The kicker names WHAT the
              rows are (teams vs players) — "Right now" alone described the
              freshness and not the content, so a first-time visitor saw
              three names and three unlabeled numbers. Rank numerals take the
              leaderboard's podium colors so the strip visually rhymes with
              the page it links to. */}
          {topRows.length > 0 && (
            <div className="mt-6 w-full max-w-md">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-[#8f8f9b]">
                {topRowsAreTeams ? "Top teams right now" : "Leading right now"}
              </p>
              <ol className="flex flex-col gap-1.5">
                {topRows.map((row, i) => (
                  <li key={row.key} className="flex items-baseline gap-3 font-mono text-sm">
                    <span
                      className="w-4 flex-none text-right font-semibold tabular-nums"
                      style={{ color: ["#d4a017", "#a1a1aa", "#14b8a6"][i] ?? "#8f8f9b" }}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-white">{row.name}</span>
                    <span className="flex-none font-semibold tabular-nums text-white">
                      {row.points.toLocaleString("en-US")}
                      <span className="ml-1 text-xs font-normal text-[#8f8f9b]">pts</span>
                    </span>
                  </li>
                ))}
              </ol>
              <Link href="/leaderboard" className="ds-link mt-2 inline-block text-xs">
                Full standings
              </Link>
            </div>
          )}
        </main>
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 py-16">
        {/* The games: one card per enabled module — the pitch, the size of the
            board, and the door in. No grading rules here by design. */}
        <section className="flex flex-col gap-6">
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {sections.length === 1 ? "The game" : "The games"}
          </h2>
          {sections.length === 0 ? (
            // Zero modules is a legal state now (issue #386): a fresh
            // deployment with no scorer image, or an organizer who switched
            // everything off. Say so — an empty grid reads as a broken page.
            <div className="rounded-lg border border-white/[0.06] bg-[#16162a] px-6 py-10 text-center">
              <p className="text-lg font-semibold text-white">No boards are open yet.</p>
              <p className="mt-2 text-sm text-muted">An organizer switches them on in the admin panel.</p>
            </div>
          ) : (
            <div className={`grid grid-cols-1 gap-4 ${gamesGrid}`}>
              {sections.map((section) => (
                <article
                  key={section.id}
                  className="ds-card flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-[#16162a] p-6"
                >
                  <h3 className="text-lg font-bold text-white">{section.title}</h3>
                  <p className="flex-1 text-sm leading-relaxed text-zinc-400">{section.intro}</p>
                  {countFor(section.id) && (
                    <p className="font-mono text-xs tabular-nums text-[#8f8f9b]">{countFor(section.id)}</p>
                  )}
                  {section.cta && (
                    <Link
                      href={section.cta.href}
                      className="mt-1 inline-flex w-fit items-center rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-[#2563eb]/45 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                    >
                      {section.cta.label}
                    </Link>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* A module's optional thesis section. For secure-development this is
            "Please use AI" — the event's actual differentiator, so it stays on
            the pitch page — with the Secure Agent Playbook card. */}
        {sections.map(
          (section) =>
            section.extra && (
              <section key={`extra-${section.id}`} className="flex flex-col gap-6">
                <div className="flex flex-col gap-3">
                  <p className="font-mono text-xs uppercase tracking-[0.25em] text-[#14b8a6]">
                    {section.extra.kicker}
                  </p>
                  <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                    {section.extra.heading}
                  </h2>
                  <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
                    {section.extra.body}
                  </p>
                </div>
                {section.id === "secure-development" && (
                  <div className="ds-card flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-[#16162a] p-6">
                    <h3 className="text-lg font-semibold text-white">
                      Start with the OWASP Secure Agent Playbook
                    </h3>
                    <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
                      OWASP&rsquo;s own open-source playbook for pointing an AI agent at a codebase.
                      It ships structured, OWASP-grounded procedures for security code review,
                      dependency and secrets scanning, and API and web assessment, each one mapped to
                      the same OWASP Top 10 categories these challenges are graded against. It turns
                      &ldquo;find the bug&rdquo; into a repeatable method, which is exactly what you
                      want against 300-plus challenges on a deadline.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <a
                        href={event.secureAgentPlaybookUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                      >
                        Get the playbook
                      </a>
                      <Link
                        href="/how-to-play#first-patch"
                        className="rounded-md border border-white/15 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/45 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                      >
                        See it in a worked example
                      </Link>
                    </div>
                  </div>
                )}
              </section>
            ),
        )}

        {/* The targets, when secure-development plays: six deliberately
            vulnerable open-source apps are the evaluator's proof this is
            real. Not all are OWASP projects (DVWA and VAmPI aren't), so the
            copy below must not say they are. */}
        {secureDevelopment && (
          <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <p className="font-mono text-xs uppercase tracking-[0.25em] text-[#14b8a6]">
                {enabledApps.length} real {enabledApps.length === 1 ? "target" : "targets"}
              </p>
              <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                {enabledTotals.challenges} challenges up for grabs
              </h2>
              <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
                Each app is a well-known, deliberately vulnerable open-source project. Points scale with
                difficulty, and the deeper flaws in {topAppsList} pay out the most.
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sortedApps.map((app) => (
                <li key={app.id}>
                  <Link
                    href="/challenges"
                    className="ds-card group flex h-full flex-col gap-2 rounded-lg border border-white/[0.06] bg-[#16162a] p-5"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-base font-bold text-white">{app.name}</h3>
                      <span className="font-mono text-xs tabular-nums text-[#8f8f9b]">
                        {catalog?.byApp[app.id]?.length ?? app.challengeCount}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-zinc-400">{app.blurb}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The evaluator's ninety seconds: what running this costs. */}
        <section className="ds-card flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-[#16162a] p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <h3 className="text-lg font-semibold text-white">Run this for your own group</h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              This event runs on OWASP CTF in a Box: one machine, one free GitHub org, no cloud account,
              scoring rubrics included. A university course, a chapter night or a weekend workshop
              can stand it up in an afternoon.
            </p>
          </div>
          <div className="flex flex-none flex-wrap gap-3">
            <a
              href="https://github.com/OWASP/owasp-ctf-in-a-box"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-[#2563eb] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
            >
              Get the kit
            </a>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-white/15 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/45 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
            >
              Read the docs
            </a>
          </div>
        </section>
      </div>

      {footer}
    </div>
  );
}
