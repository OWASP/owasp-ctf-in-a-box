// Server Component: loads scoreboard data + the viewer's session on the
// server, then renders the interactive <Leaderboard> client component with
// both. Data (and auth) in, interactivity down.

import type { Metadata } from "next";
import { headers } from "next/headers";
import PageHeader from "@/components/page-header";
import Leaderboard from "@/components/leaderboard";
import MockDataNotice from "@/components/mock-data-notice";
import { getLeaderboardSource, getLeaderboardSourceMode } from "@/lib/leaderboard/source";
import { withModuleContributions } from "@/lib/leaderboard/module-contributions";
import { withHintPenalties } from "@/lib/leaderboard/hint-penalties";
import { withTeamStandings } from "@/lib/leaderboard/team-standings";
import { withModuleSeries } from "@/lib/leaderboard/module-series";
import { formatRelativeTime } from "@/lib/relative-time";
import { auth } from "@/lib/auth";
import DisplayBoard from "@/components/display-board";
import { resolvePhase } from "@/components/phase-line";
import { completedCount } from "@/lib/leaderboard/rank";
import { getSite } from "@/lib/site";
import { getResolvedModules } from "@/lib/resolved-modules";
import { getEnabledApps } from "@/lib/enabled-apps";
import { listSponsors } from "@/lib/sponsors-store";

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "Leaderboard",
    description: `Live contestant standings for ${event.name}.`,
  };
}

// One lede for every event shape. The old secure-development branch said
// "rankings from patched PRs", which was false the moment a second module
// was enabled — quiz answers and flags rank here too, and the board itself
// folds every enabled module (issue #200, 1.4). A lede that names one
// module's currency on a shared board misinforms; the plain statement is
// true on every event including a secure-development-only one.
//
// The sign-in clause renders only for the visitor it applies to: telling a
// signed-in contestant to "Sign in with GitHub" reads as broken state
// detection (issue #200, 3.1 — the same fix the hint banner got). The page
// already loads the session for the YOU-row highlight, so this costs
// nothing.
const BASE_DESCRIPTION = "Live contestant rankings from every enabled challenge board.";
const SIGNED_OUT_CLAUSE = " Sign in with GitHub to highlight your own row and unlock your profile.";

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ display?: string }>;
}) {
  // ?display=1 is the projector surface: chrome-free top ten, viewport-scaled
  // type, self-refreshing (display-board.tsx). Resolved first so the display
  // render can skip nothing it needs and everything it doesn't.
  const wantsDisplay = (await searchParams)?.display === "1";
  const event = await getSite();
  const source = await getLeaderboardSource();
  // Penalties fold LAST: withModuleContributions attributes (and, for the
  // app-side modules, adds) each row's gross per-module points, and
  // withTeamStandings folds rows into teams — only then does
  // withHintPenalties net the final all-module total, exactly once. Module
  // blocks everywhere show their gross contribution; the row's "−N hints"
  // marker is what reconciles them against the netted header. Running the
  // fold earlier netted scorer points alone, which made hints free for any
  // row whose points arrive later — a classic- or quiz-only contestant, or
  // an upstash-path team. Same story in docs/architecture.md, step 9 of the
  // score data flow.
  //
  // withModuleSeries runs after withTeamStandings because it needs the final
  // team rows — it charts a team's roster, and a team the standings stage has
  // not added yet has no line to draw. It reads the app-side modules' per-item
  // timestamps to put their points on the chart at all (issue #415); before
  // it, the chart plotted secure-development alone while the rows counted
  // every module. It leaves `points` untouched, so it neither needs to run
  // before the penalty fold nor disturbs it: the chart is gross, the row net.
  const [data, session, modules, enabledApps] = await Promise.all([
    source
      .getLeaderboard()
      .then(withModuleContributions)
      .then(withTeamStandings)
      .then(withModuleSeries)
      .then(withHintPenalties),
    auth.api.getSession({ headers: await headers() }),
    getResolvedModules(),
    getEnabledApps(),
  ]);

  // Pre-format relative times server-side so client and server render
  // identical markup (see src/lib/relative-time.ts).
  const generatedAtMs = Date.parse(data.generatedAt);

  if (wantsDisplay) {
    // Sponsor credits are cosmetic on this surface — a Redis blip on this
    // read must never blank the projector board itself, so it fails OPEN to
    // an empty list rather than throwing (same direction as sponsor-strip.tsx
    // and site-footer.tsx's own sponsor reads).
    const [phaseInfo, sponsors] = await Promise.all([resolvePhase(), listSponsors().catch(() => [])]);
    // Teams when the event has them, individuals otherwise — the same
    // primary view the interactive board defaults to.
    const rows =
      data.teams.length > 0
        ? data.teams.slice(0, 10).map((t) => ({
            key: t.slug,
            rank: t.rank,
            name: t.name,
            points: t.points,
          }))
        : data.entries.slice(0, 10).map((e) => ({
            key: e.login,
            rank: e.rank,
            name: e.login,
            points: e.points,
            solved: completedCount(e),
          }));
    return (
      <DisplayBoard
        rows={rows}
        eventName={event.name}
        phaseLabel={phaseInfo ? phaseInfo.phase : null}
        sponsors={sponsors.map((s) => ({
          key: s.id,
          name: s.name,
          logoSrc: s.logo ? `/api/sponsors/logo/${s.id}` : null,
          w: s.logo?.w,
          h: s.logo?.h,
          logoType: s.logo?.type,
        }))}
      />
    );
  }
  const entries = data.entries.map((entry) => ({
    ...entry,
    updatedAgo: entry.updatedAt ? formatRelativeTime(entry.updatedAt, generatedAtMs) : undefined,
  }));

  const sourceMode = await getLeaderboardSourceMode();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Standings"
        title="Leaderboard"
        description={session ? BASE_DESCRIPTION : BASE_DESCRIPTION + SIGNED_OUT_CLAUSE}
      />
      {sourceMode === "mock" && <MockDataNotice startsAt={event.ctfStartsAt} />}
      {/* data.series/teamSeries pass straight through this spread — the
          chart itself lives inside <Leaderboard> now, so it can switch
          between them as the individual/teams view toggle flips. */}
      <Leaderboard
        data={{ ...data, entries }}
        viewerLogin={session?.user?.login ?? null}
        modules={modules}
        enabledApps={enabledApps}
      />
    </div>
  );
}
