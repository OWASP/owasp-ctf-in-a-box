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
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import ChallengeDetail, { type ClassicChallengeView } from "@/components/challenge-detail";
import HintRevealButton from "@/components/hint-reveal-button";
import { deriveStatus } from "@/lib/derive-status";
import { isAdminLogin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { getAdminSettings } from "@/lib/admin-store";
import {
  CLASSIC_COOLDOWN_SEC,
  getSolveCounts,
  getViewerClassic,
  listChallenges,
  type ViewerClassic,
} from "@/lib/classic-store";
import { isModuleLive } from "@/lib/enabled-modules";
import { getClassicHintIds, getHintNotice, getViewerHints } from "@/lib/hint-store";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";
import TeamlessNotice from "@/components/teamless-notice";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (!(await isModuleLive("classic"))) return {};
  const { id } = await params;
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
