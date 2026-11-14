import type { Metadata } from "next";
import PreviewBanner from "@/components/preview-banner";
import { notFound } from "next/navigation";
import PageHeader from "@/components/page-header";
import ChallengeGrid from "@/components/challenge-grid";
import { forkUrl, joinAppNames, type AppId } from "@/lib/apps";
import { getEnabledApps, getEnabledTotals } from "@/lib/enabled-apps";
import { getChallengeCatalog } from "@/lib/challenges";
import { getLeaderboardSource } from "@/lib/leaderboard/source";
// No hint imports: Secure Development has no hint text and no producer for
// it, so this page shows no hint banner and no bulbs (issue #334). Classic and
// ai keep theirs on their own boards.
import { getPlayer } from "@/lib/player";
import { headers } from "next/headers";
import { getGithubOrg } from "@/lib/bootstrap-env";
import { isModuleLive } from "@/lib/enabled-modules";
import { redirectIfNotLaunched } from "@/lib/launch";
import { getResolvedModules } from "@/lib/resolved-modules";
import { getGithubLink } from "@/lib/github-link";
import LinkGithubButton from "@/components/link-github-button";
import { firstParam, linkNotice } from "@/app/(site)/profile/link-notice";

/** This page's own name, with an organizer rename applied.
 *
 *  "Challenges" is the page's DEFAULT, not the module's display name (which
 *  is "Secure Development"), so this reads `titleOverride` and not `title`:
 *  renaming the module to "Round 1" retitles this page, but leaving the
 *  override unset keeps "Challenges" exactly as it has always read. Same
 *  rule the nav follows — see `buildNavLinks`. */
async function pageTitle(): Promise<string> {
  const mod = (await getResolvedModules()).find((m) => m.id === "secure-development");
  return mod?.titleOverride || "Challenges";
}

// A static `metadata` export cannot await the organizer's override out of
// Redis, so this is `generateMetadata` — the same conversion `/quiz` makes,
// and for the same reason. The read is memoized per request, so resolving it
// here and again in the component below costs one settings read, not two.
export async function generateMetadata(): Promise<Metadata> {
  const enabledApps = await getEnabledApps();
  const appList = joinAppNames(enabledApps.map((a) => a.name));
  return {
    title: await pageTitle(),
    description: `${enabledApps.length} deliberately vulnerable ${enabledApps.length === 1 ? "app" : "apps"} to patch: ${appList}.`,
  };
}

export default async function ChallengesPage({
  searchParams,
}: {
  /** A failed GitHub link lands back here: `error` is better-auth's code,
   *  `linked=github` marks a return from a link the player started. */
  searchParams?: Promise<{ error?: string | string[]; linked?: string | string[] }>;
} = {}) {
  // Gated on the module registry rather than on auth: this route only exists
  // at all when the secure-development module is enabled (module contract
  // §5.4), so an event without it 404s here exactly like any other unknown
  // route — same gate `/quiz` runs for its own module, and for the same
  // reason: the nav entry disappearing isn't enough, the URL itself must not
  // resolve. First statement, before anything async, so a disabled module
  // never reaches the data fetches below.
  if (!(await isModuleLive("secure-development"))) notFound();

  // The page renders dynamically regardless — the root layout resolves module
  // names per request, so every route under it does (see resolved-modules.ts).
  // The session first, on its own: the #464 pre-launch lock must run before
  // any content load (a refused viewer goes to the landing page). It also
  // feeds the viewer's own solved marks below.
  const player = await getPlayer(await headers());
  const launch = await redirectIfNotLaunched(player?.githubLogin ?? undefined);

  const [catalog, title, enabledApps, enabledTotals] = await Promise.all([
    getChallengeCatalog(),
    pageTitle(),
    getEnabledApps(),
    getEnabledTotals(),
  ]);

  // The viewer's own patched challenges, for the browser's solved state — the
  // same per-challenge results their profile shows, keyed for the grid. Only
  // when signed in and only when the source carries per-challenge data; any
  // failure degrades to "no solved marks", never to an error.
  let solved: Partial<Record<string, string[]>> = {};
  if (player) {
    try {
      const source = await getLeaderboardSource();
      const profile = await source.getUser(player.id);
      for (const app of profile?.apps ?? []) {
        // `solvedIds` is exactly the patched set, already narrowed to ids the
        // catalogue still holds (issue #434 — rows no longer carry the
        // expanded challenge list; the ids are the whole per-row fact).
        const patched = app.solvedIds ?? [];
        if (patched.length > 0) solved[app.app] = patched;
      }
    } catch {
      solved = {};
    }
  }
  const sortedApps = [...enabledApps].sort((a, b) => a.name.localeCompare(b.name));

  // Fork links come from the runtime `GITHUB_ORG`, not the (now-dead)
  // `event.yaml` bake — `null` per target when it is unset, which
  // `ChallengeGrid` renders as plain text rather than a broken link.
  const org = getGithubOrg();
  // A signed-in player sees them only once a GitHub account is linked, since
  // a PR from an unlinked author never scores. A failed link read fails
  // CLOSED: no links, and no "link your account" claim we cannot back.
  let showLinks = true;
  let needsLink = false;
  if (player) {
    try {
      needsLink = (await getGithubLink(player.id)) === null;
      showLinks = !needsLink;
    } catch {
      showLinks = false;
      console.error("challenges: github link read failed");
    }
  }
  const params = await searchParams;
  const linkMessage = needsLink ? linkNotice(firstParam(params?.error), firstParam(params?.linked), false) : null;
  const forkUrls: Partial<Record<AppId, string | null>> = {};
  if (showLinks) for (const app of sortedApps) forkUrls[app.id] = forkUrl(org, app.id);

  // The count always follows the runtime enabled-target subset, never the
  // scorer's catalogue total (CodeRabbit round 1): the scorer's /challenges
  // route returns every target in its rubric, not the app's runtime
  // secureDevTargets subset, so catalog.total can overcount when targets
  // are narrowed.
  const appNoun = enabledApps.length === 1 ? "app" : "apps";
  const description = catalog
    ? `${enabledTotals.challenges} challenges across ${enabledApps.length} vulnerable ${appNoun}, each tagged with its OWASP Top 10 category. Points scale with difficulty. Patch the regression test tied to each challenge to score it.`
    : `${enabledTotals.challenges} challenges across ${enabledApps.length} vulnerable ${appNoun}, worth ${enabledTotals.maxPoints} points total. Points scale with difficulty. Patch the regression test tied to each challenge to score it.`;

  return (
    <div className="flex flex-col gap-8">
      {/* #464: an admin browsing before launch sees what contestants will. */}
      {launch.preview && <PreviewBanner />}
      <PageHeader eyebrow="Targets" title={title} description={description} />
      {/* The scoring cadence, stated instead of silent (DESIGN.MD: "scoring
          latency — the honest version"). The app never sees a contestant's
          PR, so there is no per-run pending state to show — what it CAN say
          is when scores land and where to look when one doesn't. */}
      <p className="-mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted">
        <span aria-hidden className="mt-1 h-2 w-2 flex-none rounded-full bg-[#d4a017]" />
        <span>
          Scores land within about a minute of your pull request&rsquo;s checks finishing — your
          patched marks here and on your profile update on reload. A run that finished but scored
          nothing means the regression test still fails: open your PR&rsquo;s Checks tab on GitHub
          to see which test, fix, and push again. Your best result always stands.
        </span>
      </p>
      {needsLink && (
        <div className="flex flex-col gap-3">
          {linkMessage && (
            <p role="alert" className="rounded-md border border-[#d4a017]/40 bg-[#d4a017]/10 px-4 py-2 text-sm text-white">
              {linkMessage}
            </p>
          )}
          <p role="status" className="rounded-md border border-[#d4a017]/40 bg-[#d4a017]/10 px-4 py-2 text-sm text-white">
            Link your GitHub account to start.
          </p>
          <LinkGithubButton callbackURL="/challenges?linked=github" />
        </div>
      )}
      <ChallengeGrid
        apps={sortedApps}
        catalog={catalog?.byApp ?? null}
        hints={{}}
        solved={solved}
        forkUrls={forkUrls}
      />
    </div>
  );
}
