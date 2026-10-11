// Server Component: loads scoreboard data + the viewer's session on the
// server, then renders the interactive <Leaderboard> client component with
// both. Data (and auth) in, interactivity down.

import type { Metadata } from "next";
import { boardQr } from "@/lib/qr-code";
import PreviewBanner from "@/components/preview-banner";
import { headers } from "next/headers";
import PageHeader from "@/components/page-header";
import Leaderboard from "@/components/leaderboard";
import MockDataNotice from "@/components/mock-data-notice";
import { getLeaderboardSourceMode } from "@/lib/leaderboard/source";
import { redirectIfNotLaunched } from "@/lib/launch";
import { getFoldedLeaderboard } from "@/lib/leaderboard/folded";
import { formatRelativeTime } from "@/lib/relative-time";
import { auth } from "@/lib/auth";
import DisplayBoard from "@/components/display-board";
import { resolvePhase } from "@/components/phase-line";
import { completedCount } from "@/lib/leaderboard/rank";
import { getSite } from "@/lib/site";
import { getResolvedModules } from "@/lib/resolved-modules";
import { getEnabledApps } from "@/lib/enabled-apps";
import { listSponsors } from "@/lib/sponsors-store";
import { getAdminSettingsSnapshot } from "@/lib/enabled-modules";
import { getEventImages } from "@/lib/event-images-site";
import { eventImageUrl } from "@/lib/event-images-keys";
import Image from "next/image";
import HeaderLogo from "@/components/header-logo";
import SponsorStrip from "@/components/sponsor-strip";

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

/**
 * The public standings page — the interactive board by default, the
 * chrome-free projector board with `?display=1`. Reads the shared 10 s fold
 * memo plus this viewer's session, modules and enabled apps.
 */
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
  // The folded board — source → module contributions → team standings →
  // module series → hint penalties — is identical for every viewer, so it is
  // memoized across requests for 10 s in folded.ts (issue #444), which also
  // owns the stage-order commentary. The one per-viewer input on this page
  // is the "you" highlight, and <Leaderboard> applies that from viewerLogin.
  // `data` is shared with every concurrent request: read it, never mutate it
  // — the spreads below build new objects.
  // #464 pre-launch lock, before the board is read: standings (and the
  // projector surface) are module content. Admins get through as a preview.
  const session = await auth.api.getSession({ headers: await headers() });
  const launch = await redirectIfNotLaunched((session?.user as { login?: string } | undefined)?.login);

  const [data, modules, enabledApps] = await Promise.all([
    getFoldedLeaderboard(),
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
    //
    // The logo size is the organizer's `sponsorLogoSize` — the same setting
    // the landing strip reads, so one /admin control sizes both surfaces.
    // `getAdminSettingsSnapshot` already fails open to null internally, and
    // DisplayBoard's own `?? "md"` covers "nothing stored yet".
    const [phaseInfo, sponsors, settings, images] = await Promise.all([
      resolvePhase(),
      listSponsors().catch(() => []),
      getAdminSettingsSnapshot(),
      // The event's logo for the wall (#543). getEventImages fails open to
      // "none stored", so a read error leaves the header as the name alone.
      getEventImages(),
    ]);
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
        logoSize={settings?.sponsorLogoSize ?? undefined}
        eventLogo={images.logo ? { src: eventImageUrl("logo", images.logo), w: images.logo.w, h: images.logo.h } : null}
        scoringStartsAt={settings?.scoringStartsAt ?? null}
        scoringEndsAt={settings?.scoringEndsAt ?? null}
        qr={boardQr(settings, process.env.BETTER_AUTH_URL)}
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

  // The event's identity on the regular board (ADR 66), not only on the
  // projector: its logo beside the title and the sponsor strip under the
  // header. Both reads fail open (getEventImages to "none stored",
  // SponsorStrip to null), so a Redis blip costs the decoration, never the
  // standings. SponsorStrip is called rather than mounted for the reason its
  // own header gives.
  const [sourceMode, images, sponsorStrip] = await Promise.all([
    getLeaderboardSourceMode(),
    getEventImages(),
    SponsorStrip(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      {/* #464: an admin browsing before launch sees what contestants will. */}
      {launch.preview && <PreviewBanner />}
      <PageHeader
        eyebrow="Standings"
        title="Leaderboard"
        description={session ? BASE_DESCRIPTION : BASE_DESCRIPTION + SIGNED_OUT_CLAUSE}
        logo={
          images.logo ? (
            <HeaderLogo
              key={eventImageUrl("logo", images.logo)}
              src={eventImageUrl("logo", images.logo)}
              w={images.logo.w}
              h={images.logo.h}
              alt={`${event.name} logo`}
            />
          ) : (
            // No uploaded logo: the default OWASP mark, the same one the
            // landing page's hero falls back to.
            <Image
              src="/owasp-logo.png"
              alt="OWASP"
              width={200}
              height={69}
              className="h-auto w-28 shrink-0 invert sm:w-36"
            />
          )
        }
      />
      {sponsorStrip}
      {sourceMode === "mock" && <MockDataNotice startsAt={event.ctfStartsAt} />}
      {/* data.series/teamSeries pass straight through this spread — the
          chart itself lives inside <Leaderboard> now, so it can switch
          between them as the individual/teams view toggle flips. */}
      <Leaderboard
        data={{ ...data, entries }}
        viewerLogin={session?.user?.login ?? null}
        modules={modules}
        enabledApps={enabledApps}
        timeZone={event.timeZone}
      />
    </div>
  );
}
