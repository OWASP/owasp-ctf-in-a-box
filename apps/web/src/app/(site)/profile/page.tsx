// Gated Server Component: real gate (proxy.ts only does an optimistic cookie
// check — this getSession call is what actually matters). Loads the
// contestant's progress from the active leaderboard source and renders their
// dossier: identity, overall progress, per-app breakdown, and team control.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import PageHeader from "@/components/page-header";
import AppBreakdown from "@/components/app-breakdown";
import ProgressRow, { moduleUnit } from "@/components/progress/progress-row";
import ChallengeList from "@/components/progress/challenge-list";
import RemainingLine from "@/components/progress/remaining-line";
import { maxPointsAcrossModules } from "@/app/(site)/profile/module-blocks";
import { fillStyle } from "@/components/progress/progress-bar";
import ProfileStatTiles, { type StatTile } from "@/components/profile-stat-tiles";
import { loadTeamStanding } from "@/app/(site)/profile/team-standing";
import {
  buildModuleProgress,
  moduleItemsFor,
  moduleRow,
  remainingFor,
  type ProfileModuleInput,
} from "@/app/(site)/profile/module-blocks";
import TeamCard from "@/components/team-card";
import TeamProgress from "@/components/team-progress";
import type { AppId } from "@/lib/apps";
import { getEnabledApps, getEnabledAppsById, getEnabledTotals } from "@/lib/enabled-apps";
import { auth } from "@/lib/auth";
import {
  getAiTotals,
  getViewerAi,
  listAiChallenges,
  type AiChallenge,
  type AiTotal,
  type ViewerAi,
} from "@/lib/ai-store";
import {
  getClassicTotals,
  getViewerClassic,
  listChallenges,
  type Challenge,
  type ClassicTotal,
  type ViewerClassic,
} from "@/lib/classic-store";
import { getViewerHints } from "@/lib/hint-store";
import type { AppProgress, LeaderboardEntry } from "@/lib/leaderboard/types";
import { getLeaderboardSource } from "@/lib/leaderboard/source";
import { challengeTotal } from "@/lib/leaderboard/non-patched";
import { getQuizTotals, getViewerQuiz, listQuestions, type Question, type QuizTotal, type ViewerQuiz } from "@/lib/quiz-store";
import { getEnabledModuleIds } from "@/lib/enabled-modules";
import { getResolvedModules } from "@/lib/resolved-modules";
import { getViewerTeam, resolveTeamMaxMembers, TEAM_WRITES_ENABLED } from "@/lib/team-store";
import { teamKey } from "@/lib/team-keys";
import { getAdminSettings, effectiveRegistrationOpen } from "@/lib/admin-store";
import { upstashPipeline } from "@/lib/upstash";
import { getSite } from "@/lib/site";

// TeamCard needs the captain login (to gate captain-only controls) and the
// current join code (to display it), neither of which `TeamInfo` carries, so
// the two fields are read here from the team hash — one pipeline, both HGETs.
// The key comes from the shared `teamKey` builder (team-keys.ts, ADR 48), never
// an open-coded key string — that is how two readers of the same data drift
// apart, and team-keys.test.ts scans this file to keep it that way.
// Live mode only — the mock cookie has no captain/join-code concept.
async function getTeamMeta(slug: string): Promise<{ captain: string | null; joinCode: string | null }> {
  if (!TEAM_WRITES_ENABLED) return { captain: null, joinCode: null };
  try {
    const [captainRes, codeRes] = await upstashPipeline([
      ["HGET", teamKey(slug), "captain"],
      ["HGET", teamKey(slug), "joinCode"],
    ]);
    return {
      captain: typeof captainRes.result === "string" && captainRes.result ? captainRes.result : null,
      joinCode: typeof codeRes.result === "string" && codeRes.result ? codeRes.result : null,
    };
  } catch {
    return { captain: null, joinCode: null };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "Profile",
    // Generic on purpose — "challenges" is secure-development's own noun, and
    // this page must read cleanly on a quiz-only event too. Mirrors
    // leaderboard/page.tsx's equally module-agnostic description.
    description: `Your personal progress in ${event.name}.`,
  };
}

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");

  const login = (session.user as { login?: string }).login;
  if (!login) redirect("/");

  const liveModules = await getEnabledModuleIds();
  const quizEnabled = liveModules.has("quiz");
  const classicEnabled = liveModules.has("classic");
  const aiEnabled = liveModules.has("ai");
  const secureDevEnabled = liveModules.has("secure-development");

  // Quiz/classic/ai totals and item lists are per-login and cheap to fetch
  // here regardless of board size (two HGETALLs each — see getQuizTotals /
  // getClassicTotals / getAiTotals), but only when the module is enabled:
  // this must never read `ctf:quiz:*` when quiz is off, nor `ctf:classic:*`
  // when classic is, nor `ctf:ai:*` when ai is. `resolvedModules`
  // (organizer-renamed titles) is what drives the per-module breakdown below
  // off the enabled-module LIST rather than a per-module branch — see the
  // module block loop.
  const [
    profile,
    storeTeam,
    viewerHints,
    quizTotals,
    quizQuestions,
    classicTotals,
    classicChallenges,
    aiTotals,
    aiChallenges,
    viewerQuiz,
    viewerClassic,
    viewerAi,
    resolvedModules,
    maxMembers,
    adminSettings,
    enabledAppsById,
    enabledTotals,
    enabledApps,
  ] =
    await Promise.all([
      getLeaderboardSource().then((source) => source.getUser(login)),
      getViewerTeam(login),
      getViewerHints(login),
      quizEnabled ? getQuizTotals() : Promise.resolve(new Map<string, QuizTotal>()),
      quizEnabled ? listQuestions() : Promise.resolve([] as Question[]),
      classicEnabled ? getClassicTotals() : Promise.resolve(new Map<string, ClassicTotal>()),
      classicEnabled ? listChallenges() : Promise.resolve([] as Challenge[]),
      aiEnabled ? getAiTotals() : Promise.resolve(new Map<string, AiTotal>()),
      aiEnabled ? listAiChallenges() : Promise.resolve([] as AiChallenge[]),
      // The viewer's OWN per-item progress, for the blocks' Show-N lists —
      // the same reads the boards themselves make, module-gated identically.
      quizEnabled ? getViewerQuiz(login) : Promise.resolve<ViewerQuiz>({ answered: {}, attempts: {} }),
      classicEnabled ? getViewerClassic(login) : Promise.resolve<ViewerClassic>({ solved: {}, attempts: {} }),
      aiEnabled ? getViewerAi(login) : Promise.resolve<ViewerAi>({ solved: {}, attempts: {} }),
      getResolvedModules(),
      // The SAME resolver joinTeam uses. Reading TEAM_MAX_MEMBERS here instead
      // would advertise a limit the join path does not enforce — the split
      // ADR 31 records from the hint toggle. It rides along in this existing
      // Promise.all, so it costs no extra round-trip.
      resolveTeamMaxMembers(),
      // For the team card's registration-closed explanation. Same
      // read-and-explain the /join/<code> page does: the team routes are the
      // enforcement, this is so a teamless contestant sent here after
      // registration closed reads why, instead of forms that refuse them.
      // Fail-open like the routes' own reads: an error means "open".
      getAdminSettings().catch(() => null),
      getEnabledAppsById(),
      getEnabledTotals(),
      getEnabledApps(),
    ]);

  // Live/mock team membership from the store wins; fall back to whatever the
  // leaderboard source reports (only the mock fixture populates it today).
  const team =
    storeTeam ??
    (profile?.team ? { slug: profile.team, name: profile.teamName ?? profile.team, members: [] } : null);
  const effectiveTeam = team?.slug ?? null;
  const teamMeta = team ? await getTeamMeta(team.slug) : { captain: null, joinCode: null };

  // The team's scoring picture, from the SAME pipeline (and the same overlay
  // order) the public leaderboard runs, so the panel and the board can never
  // disagree about the team's total. A failed read drops the panel, never the
  // page — this is a progress display, not a gate.
  const { standing: teamStanding, memberEntries: teamMemberEntries } = await loadTeamStanding(team);
  const isCaptain = teamMeta.captain !== null && teamMeta.captain === login;
  // Both derived through the SAME helper the public leaderboard row uses, so
  // a contestant's own dossier and their board row can't disagree about what
  // "non-patched" counts. This page used to compute it off `profile.total` —
  // the number of challenges with a scored result — which made a contestant
  // with nothing submitted read `0 non-patched / 0 total` on an event with a
  // full catalogue to work through.
  const patchedCount = profile?.patched ?? 0;
  const challengeCount = challengeTotal(enabledTotals.challenges, profile?.total ?? 0);
  // Hint spend is deducted and the app-side modules' points are added, in that
  // order, as overlays — the exact same math (and order) as the leaderboard's
  // withHintPenalties (subtract, floor at 0) followed by
  // withModuleContributions (add quiz and classic points on top) — so the
  // profile matches the contestant's public row.
  const quizTotal = quizTotals.get(login);
  const quizPoints = quizTotal?.points ?? 0;
  const classicTotal = classicTotals.get(login);
  const classicPoints = classicTotal?.points ?? 0;
  const aiTotal = aiTotals.get(login);
  const aiPoints = aiTotal?.points ?? 0;
  // Net-of-hints TOTAL: the penalty subtracts from the all-module sum,
  // floored at 0 — the same math (and the same single application) as the
  // board's withHintPenalties, which now runs as the pipeline's LAST stage.
  // Netting scorer points alone (the old form) made hints free whenever the
  // spend exceeded scorer points — every classic-, quiz-, or ai-heavy
  // contestant.
  const netPoints = Math.max(0, (profile?.points ?? 0) + quizPoints + classicPoints + aiPoints - viewerHints.spent);
  // The bar's denominator covers every enabled module, because its numerator
  // does: netPoints already includes quiz and classic. Dividing an all-module
  // numerator by secure-development's maxPoints alone (the old behaviour) let
  // the two drift — a quiz-heavy contestant's bar understated them against a
  // ceiling they weren't playing toward (issue #200, 2.4). Clamped because a
  // deleted question/challenge deliberately leaves banked points in place, so
  // the numerator can legitimately exceed a shrunken denominator.
  const quizMaxPoints = quizQuestions.reduce((sum, q) => sum + (Number(q.points) || 0), 0);
  const classicMaxPoints = classicChallenges.reduce((sum, c) => sum + (Number(c.points) || 0), 0);
  const aiMaxPoints = aiChallenges.reduce((sum, c) => sum + (Number(c.points) || 0), 0);
  // Only the apps the event actually enabled — same filter the per-app grid
  // used before this task, kept so a target an organizer turned off never
  // shows up in the breakdown just because a stale scored row mentions it.
  const appsRecord: Partial<Record<AppId, AppProgress>> = {};
  for (const app of profile?.apps ?? []) {
    if (enabledAppsById[app.app]) appsRecord[app.app] = app;
  }

  // Everything the per-module builders read, in one place — the page fetches,
  // module-blocks.ts does the arithmetic. A module's slice is undefined
  // exactly when that module is disabled, which is what keeps a disabled
  // module out of every derived figure below.
  const moduleInput: ProfileModuleInput = {
    profile,
    appsRecord,
    challengeCount,
    enabledMaxPoints: enabledTotals.maxPoints,
    secureDev: secureDevEnabled,
    quiz: quizEnabled ? { total: quizTotal, questions: quizQuestions, maxPoints: quizMaxPoints, viewer: viewerQuiz } : undefined,
    classic: classicEnabled
      ? { total: classicTotal, challenges: classicChallenges, maxPoints: classicMaxPoints, viewer: viewerClassic }
      : undefined,
    ai: aiEnabled ? { total: aiTotal, challenges: aiChallenges, maxPoints: aiMaxPoints, viewer: viewerAi } : undefined,
  };

  // The same union the module rows use, so the header cannot disagree with the
  // rows beneath it: points banked on a challenge an organizer has since
  // deleted still count, and a live-catalogue ceiling alone renders
  // "870 of 850 pts available" (issue #330).
  const maxPointsAllModules = maxPointsAcrossModules(moduleInput, profile?.points ?? 0);
  // Sources without per-challenge point data (lambda/upstash) report
  // maxPoints 0 — fall back to patched/total so the bar still means something.
  const progressPct =
    maxPointsAllModules > 0
      ? Math.min(100, (netPoints / maxPointsAllModules) * 100)
      : challengeCount > 0
        ? (patchedCount / challengeCount) * 100
        : 0;
  // Whichever numerator actually drove progressPct above — points when the
  // bar has point data, the patched count when it fell back — so the fill
  // floor triggers exactly when there is genuine nonzero progress to show.
  const progressValue = maxPointsAllModules > 0 ? netPoints : patchedCount;

  const moduleProgress = buildModuleProgress(moduleInput);
  // `ModuleDetail`/`AppBreakdown` (the same renderers the leaderboard uses)
  // take a `LeaderboardEntry`; this page only ever has a `UserProfile`, which
  // has no `modules` map, so a minimal stand-in is built here rather than
  // adding a second breakdown renderer for one page.
  const moduleEntry: LeaderboardEntry = {
    rank: 0,
    login,
    team: effectiveTeam,
    points: netPoints,
    patched: profile?.patched ?? 0,
    failed: profile?.failed ?? 0,
    total: profile?.total ?? 0,
    apps: appsRecord,
    updatedAt: profile?.updatedAt ?? null,
  };
  const moduleBlocks = resolvedModules.filter((m) => moduleProgress[m.id]);
  // Header tiles, in enabled-module order. Each denominator is clamped to its
  // own numerator for the same reason every other one on this page is: a
  // deleted item leaves banked points and the count behind it.
  const statTiles: StatTile[] = [
    // Clamped for the same reason the module row's denominator is: a removed
    // target leaves the banked patch count above a shrunken catalogue.
    secureDevEnabled && {
      unit: moduleUnit("secure-development"),
      done: patchedCount,
      total: Math.max(challengeCount, patchedCount),
      accent: "#22c55e",
    },
    quizEnabled && quizQuestions.length > 0 && {
      unit: moduleUnit("quiz"),
      done: quizTotal?.answered ?? 0,
      total: Math.max(quizQuestions.length, quizTotal?.answered ?? 0),
    },
    classicEnabled && classicChallenges.length > 0 && {
      unit: moduleUnit("classic"),
      done: classicTotal?.solved ?? 0,
      total: Math.max(classicChallenges.length, classicTotal?.solved ?? 0),
    },
    aiEnabled && aiChallenges.length > 0 && {
      unit: moduleUnit("ai"),
      done: aiTotal?.solved ?? 0,
      total: Math.max(aiChallenges.length, aiTotal?.solved ?? 0),
    },
  ].filter((t): t is StatTile => Boolean(t));
  const remainingModules = remainingFor(resolvedModules, moduleInput);

  return (
    <div className="flex flex-col gap-8">
      {/* "target" is secure-development's own noun (and trips the shared
          secure-dev vocabulary guard on a quiz-only event) — kept generic so
          this reads the same regardless of which modules are enabled. */}
      <PageHeader eyebrow="Agent dossier" title={login} description="Your personal progress this event." />

      <div className="ds-card flex flex-col gap-4 rounded-lg border border-white/[0.06] bg-[#16162a] p-5 sm:flex-row sm:items-center">
        <Image
          src={session.user.image ?? `https://avatars.githubusercontent.com/${login}`}
          alt=""
          width={64}
          height={64}
          className="flex-none rounded-full border border-white/10"
          unoptimized
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="font-mono text-lg text-white">{login}</p>
            {effectiveTeam && (
              <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {effectiveTeam}
              </span>
            )}
          </div>
          <div className="mt-3 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#14b8a6]"
              style={fillStyle(progressPct, progressValue)}
            />
          </div>
          {/* The bar says WHAT it measures — an unlabeled bar reads as
              decoration, and its denominator (every enabled module's points)
              is not guessable. Falls back to the same done/total pair the
              percentage itself falls back to. */}
          <p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted">
            {maxPointsAllModules > 0
              ? `${netPoints.toLocaleString("en-US")} of ${maxPointsAllModules.toLocaleString("en-US")} pts available`
              : challengeCount > 0
                ? `${patchedCount} of ${challengeCount} done`
                : null}
          </p>
        </div>
        {/* One done/available stat per enabled module, each in its own
            vocabulary — see profile-stat-tiles.tsx for what it replaced. */}
        <ProfileStatTiles netPoints={netPoints} hints={viewerHints} tiles={statTiles} />
      </div>

      {/* `#team` is the target `redirectIfTeamless` sends a teamless
          contestant to (lib/require-team.ts). Without it they land at the top
          of a page of stats with no indication of why they were moved.
          `scroll-mt-*` keeps the card clear of the sticky header. */}
      <div id="team" className="scroll-mt-24 flex flex-col gap-4">
        <TeamCard
          team={team}
          writesEnabled={TEAM_WRITES_ENABLED}
          maxMembers={maxMembers}
          isCaptain={isCaptain}
          captain={teamMeta.captain}
          joinCode={teamMeta.joinCode}
          registrationOpen={adminSettings === null ? true : effectiveRegistrationOpen(adminSettings)}
        />
        {teamStanding && teamMemberEntries.length > 0 && (
          <TeamProgress
            standing={teamStanding}
            memberEntries={teamMemberEntries}
            viewerLogin={login}
          />
        )}
      </div>

      {/* Each enabled module's own contribution — driven off `moduleBlocks`
          (`resolvedModules` filtered to the ones with progress to show), NOT
          a per-module branch, so a third module needs no edit here. Reuses
          `ModuleDetail` (secure-development renders through `AppBreakdown`,
          same as an expanded leaderboard row) rather than a second
          breakdown renderer for this page. */}
      {moduleBlocks.length === 0 ? (
        <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] px-5 py-10 text-center">
          <p className="text-sm text-zinc-400">
            {secureDevEnabled
              ? "No scored PRs yet. Submit a patch to start earning points."
              : "No points yet — dive in below to get started."}
          </p>
          <Link href="/how-to-play" className="mt-3 inline-block text-sm ds-link">
            How to play →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {moduleBlocks.map((m) => {
            const summary = moduleRow(moduleProgress[m.id]!, moduleInput);
            const list = moduleItemsFor(m.id, moduleInput);
            const isSecureDev = moduleProgress[m.id]!.detail.kind === "secure-development";
            // One row shape at every level: the module row opens into its
            // targets (secure-development) or straight into its own grouped
            // list. The title is redundant on a single-module event, but the
            // row still needs a label for its bar, so the module's own name
            // stands in rather than the row losing its accessible name.
            return (
              <div key={m.id} data-testid="module-block" className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-4">
                <ProgressRow label={m.title} level="module" {...summary}>
                  {isSecureDev ? (
                    <AppBreakdown entry={moduleEntry} showPoints enabledApps={enabledApps} catalog={profile?.catalog} />
                  ) : list ? (
                    <ChallengeList items={list.items} unit={summary.unit} doneWord={list.doneWord} />
                  ) : undefined}
                </ProgressRow>
              </div>
            );
          })}
          {/* The one line here that is not a restatement: what is still
              winnable, and where most of it is. Everything above answers
              "how am I doing"; a contestant mid-event is asking "where do I
              go next". */}
          <RemainingLine modules={remainingModules} />
        </div>
      )}
    </div>
  );
}
