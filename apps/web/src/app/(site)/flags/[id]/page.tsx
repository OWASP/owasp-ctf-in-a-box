// One classic challenge, on its own URL (issue #208) — the page a board tile
// opens, and the page an organizer can drop in chat ("look at /flags/
// robots-only"). Carries everything the old inline card carried: title,
// category, points, solve count, the case-sensitive badge, the markdown
// description, and the flag form with its cooldown/solved states.
//
// Same server/client split as the board's page: this Server Component reads
// the session and the module's public-safe data, derives the viewer's status
// through the SAME `deriveStatus` the board uses (so a tile and its page can
// never disagree), and hands a plain view model to <ChallengeDetail>. The
// view model is built FIELD BY FIELD from the public record — never a spread
// of a raw store row, which is how a flag would leak.
//
// Gated exactly like /flags: the route 404s when the classic module is off,
// and 404s for an unknown or deleted challenge id.

import type { Metadata } from "next";
import PreviewBanner from "@/components/preview-banner";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import ChallengeDetail, { type ClassicChallengeView } from "@/components/challenge-detail";
import HintRevealButton from "@/components/hint-reveal-button";
import { deriveStatus } from "@/lib/derive-status";
import { isAdminLogin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { getAdminSettings } from "@/lib/admin-store";
import { listStories,
  CLASSIC_COOLDOWN_SEC,
  getSolveCounts,
  getViewerClassic,
  listChallenges,
  type ViewerClassic,
} from "@/lib/classic-store";
import { isModuleLive } from "@/lib/enabled-modules";
import { getLaunchAccess, redirectIfNotLaunched } from "@/lib/launch";
import { getTeamClassicSolvedIds } from "@/lib/classic-team";
import { isLocked, storyPositions } from "@/lib/story-lock";
import { getClassicHintIds, getHintNotice, getViewerHints } from "@/lib/hint-store";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";
import TeamlessNotice from "@/components/teamless-notice";

/** Whether `id` is a story step still locked for `login`'s team (#463). A
 *  stories or team read that fails THROWS — the page errors rather than
 *  showing a step it cannot prove is open. */
async function storyLockedFor(id: string, login: string | undefined): Promise<boolean> {
  const pos = storyPositions(await listStories()).get(id);
  if (!pos?.prereq) return false;
  return isLocked(pos, login ? await getTeamClassicSolvedIds(login) : new Set());
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (!(await isModuleLive("classic"))) return {};
  // #464: metadata renders on its own path (a flight response can carry it
  // next to the page's redirect), so it is locked too — a refused viewer gets
  // no title, category or points, and not even whether the id exists.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!(await getLaunchAccess((session?.user as { login?: string } | undefined)?.login)).allowed) return {};
  const { id } = await params;
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (await storyLockedFor(decodeURIComponent(id), login)) return {}; // #463: nothing about a locked step
  const challenge = (await listChallenges()).find((c) => c.id === decodeURIComponent(id));
  if (!challenge) return {};
  return {
    title: challenge.title,
    // The description is challenge CONTENT (may carry markdown, links, the
    // organizer's phrasing) — the meta description stays a neutral frame.
    description: `${challenge.category} · ${challenge.points} points.`,
  };
}

export default async function ClassicChallengePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleLive("classic"))) notFound();
  const { id } = await params;
  const challengeId = decodeURIComponent(id);

  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  // #464 pre-launch lock: before ANY content load below. A refused viewer
  // (not launched, not an admin) goes to the landing page.
  const launch = await redirectIfNotLaunched(login);
  const viewerIsAdmin = await isAdminLogin(login);

  // Same order as /flags: the team redirect fires before the loads below, so
  // a teamless contestant is never bounced after work that gets thrown away.
  // `true` only for an admin let through without a team (issue #357):
  // the notice below is the half of that exemption that was missing.
  const viewerIsTeamless = await redirectIfTeamless(login, { isAdmin: viewerIsAdmin });

  const [challenges, solveCounts, viewerClassic, settings, modules, hintIds, hintNotice, viewerHints] =
    await Promise.all([
      listChallenges(),
      getSolveCounts(),
      login ? getViewerClassic(login) : Promise.resolve<ViewerClassic>({ solved: {}, attempts: {} }),
      getAdminSettings(),
      getResolvedModules(),
      getClassicHintIds(),
      getHintNotice(),
      // The viewer's owned hint TEXT renders server-side — the reveal button
      // only exists while there is something left to buy.
      login ? getViewerHints(login) : Promise.resolve(null),
    ]);

  const challenge = challenges.find((c) => c.id === challengeId);
  if (!challenge) notFound();
  // #463: a locked story step is a 404, the same as an unknown id — its page
  // must reveal nothing, not even that it exists. An admin preview (#464) may
  // open it, to test the whole story before launch.
  if (!launch.preview && (await storyLockedFor(challengeId, login))) notFound();

  const moduleTitle = modules.find((m) => m.id === "classic")?.title ?? "Jeopardy";
  const cooldownMs = (settings.classicCooldownSec ?? CLASSIC_COOLDOWN_SEC) * 1000;

  // Field by field, never a spread — a spread of the store record is how a
  // flag would leak into props.
  const view: ClassicChallengeView = {
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    description: challenge.description,
    points: challenge.points,
    solveCount: solveCounts.get(challenge.id) ?? 0,
    caseSensitive: challenge.caseSensitive,
    ...deriveStatus(viewerClassic.solved[challenge.id], viewerClassic.attempts[challenge.id], cooldownMs),
  };

  return (
    <div className="flex flex-col gap-6">
      {/* #464: an admin browsing before launch sees what contestants will. */}
      {launch.preview && <PreviewBanner />}
      {viewerIsTeamless && <TeamlessNotice what="solves" />}
      <div className="flex flex-col gap-3">
        <Link href="/flags" className="ds-link w-fit text-sm">
          ← {moduleTitle}
        </Link>
        <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#14b8a6]">
          {challenge.category}
        </p>
        <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {challenge.title}
        </h1>
      </div>

      {/* Paid hint (#190): the owned text renders server-side; the buy
          button (client) exists only while unowned, hints are on, and the
          viewer is signed in — a signed-out visitor sees that a hint exists
          without an affordance that would 401. */}
      {hintNotice.active && hintIds.includes(challenge.id) && (
        <div className="max-w-xl">
          {viewerHints?.classic[challenge.id] ? (
            <p className="rounded border-l-2 border-[#d4a017]/50 bg-[#d4a017]/[0.06] px-3 py-2 text-sm leading-relaxed text-[#d4a017]/90">
              💡 {viewerHints.classic[challenge.id]}
            </p>
          ) : login ? (
            <HintRevealButton app="classic" id={challenge.id} cost={hintNotice.cost} />
          ) : (
            <p className="text-xs text-muted">
              This one has a paid hint ({hintNotice.cost} pts) — sign in to reveal it.
            </p>
          )}
        </div>
      )}

      {/* No page-level sign-in prompt: the card renders its own next to the
          form — one statement, where the action is (the same dedupe the
          board pages already follow). */}
      {/* The card repeats title/points/solves in its own header — kept: it is
          the same component the tests pin (#126 ordering, cooldown copy), and
          on a long description the recap beside the form is what keeps the
          submit affordance self-describing after the h1 scrolls away. */}
      <ChallengeDetail challenge={view} authenticated={Boolean(login)} submitPath="/api/classic/submit" />
    </div>
  );
}
