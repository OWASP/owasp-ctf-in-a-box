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
import {
  CLASSIC_COOLDOWN_SEC,
  getSolveCounts,
  getViewerClassic,
  listChallenges,
  type ViewerClassic,
} from "@/lib/classic-store";
import { classicVisibility } from "@/lib/classic-visibility";
import { listAttachments } from "@/lib/attachments-store";
import type { AttachmentView } from "@/components/attachment-list";
import { isModuleLive } from "@/lib/enabled-modules";
import { redirectIfNotLaunched } from "@/lib/launch";
import { getClassicHintIds, getHintNotice, getViewerHints } from "@/lib/hint-store";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";
import TeamlessNotice from "@/components/teamless-notice";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  // #464/#463: metadata renders on its own path (a flight response can carry
  // it next to the page's redirect), so it asks the same visibility question
  // as the page — a refused viewer gets no title, category or points, and not
  // even whether the id exists.
  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  const { id } = await params;
  const challengeId = decodeURIComponent(id);
  if ((await classicVisibility(login, challengeId)).state !== "visible") return {};
  const challenge = (await listChallenges()).find((c) => c.id === challengeId);
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
      // The viewer's owned hint text, read server-side (never for an
      // unowned viewer) and handed to the reveal control as `ownedText`.
      login ? getViewerHints(login) : Promise.resolve(null),
    ]);

  const challenge = challenges.find((c) => c.id === challengeId);
  if (!challenge) notFound();
  // #463/#186: the shared visibility answer — the attachment download route
  // asks the same one. A locked story step is a 404, the same as an unknown
  // id: its page must reveal nothing, not even that it exists. An admin
  // preview (#464) may open it, to test the whole story before launch.
  if ((await classicVisibility(login, challengeId)).state !== "visible") notFound();

  // Read only once the challenge is known visible (#186). Field by field for
  // the same reason as the view below: the sha256 and chunk bookkeeping stay
  // out of props. A read error throws — the page errors rather than render a
  // challenge whose files it could not check.
  const attachments: AttachmentView[] = (await listAttachments("classic", challenge.id))
    // A missing upload is not offered, so it never reaches the client either.
    .filter((a) => !(a.kind === "upload" && a.missing))
    .map((a) =>
    a.kind === "link"
      ? { id: a.id, kind: "link", name: a.name, url: a.url ?? "" }
      : { id: a.id, kind: "upload", name: a.name, size: a.size ?? 0 },
  );

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
    attachments,
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

      {/* Paid hint (#190): hints are on and this challenge has one; the
          signed-in viewer gets the reveal control, with the server-known
          owned text passed in as a prop so the SAME component renders it
          before and after router.refresh() (#560) — a separate owned <p>
          would unmount it and lose the spend/balance acknowledgement. A
          signed-out visitor sees that a hint exists without an affordance
          that would 401. */}
      {hintNotice.active && hintIds.includes(challenge.id) && (
        <div className="max-w-xl">
          {login ? (
            <HintRevealButton
              app="classic"
              id={challenge.id}
              cost={hintNotice.cost}
              ownedText={viewerHints?.classic[challenge.id] ?? null}
            />
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
