// One ai challenge, on its own URL — mirrors classic's flags/[id]/page.tsx
// structurally (same session/gate/load order, same field-by-field view
// model), with the module's two differences:
//
//   1. THE LAUNCHER. A signed-in viewer gets a personal, one-click link to
//      the externally hosted challenge — this is the ONE place in the app
//      that mints it. `mintLaunchUrl` (ai-launch.ts) is called from behind
//      every gate this render already passed: the module-enabled check
//      above, a real session, and the team redirect below. No other route
//      calls it. A signed-out visitor sees a sign-in prompt where the
//      launcher would be, and the mint is never reached at all — there is no
//      branch that calls it without `login` in hand.
//   2. THE FORM. `mode: "event"` means the box never grades a typed flag for
//      this challenge, so no <ChallengeDetail> renders at all — the launcher
//      is the whole page. `flag`/`both` render the same shared component
//      classic uses, wired to the Server Action in ./actions.ts rather than
//      to a submit ROUTE: /api/ai/submit authenticates the launch token,
//      which never leaves the href above (spec §6.1's 2026-09-02 amendment).
//
// Gated exactly like /ai: the route 404s when the module is off, and 404s
// for an unknown or deleted challenge id (issue #209's dual-cause not-found,
// in `[id]/not-found.tsx`).

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ChallengeDetail, { type ChallengeView } from "@/components/challenge-detail";
import HintRevealButton from "@/components/hint-reveal-button";
import { deriveStatus } from "@/lib/derive-status";
import { isAdminLogin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { mintLaunchUrl } from "@/lib/ai-launch";
import { resolveOrigin } from "@/lib/app-origin";
import {
  AI_COOLDOWN_SEC,
  getAiSolveCounts,
  getViewerAi,
  listAiChallenges,
  type ViewerAi,
} from "@/lib/ai-store";
import { isModuleLive } from "@/lib/enabled-modules";
import { requireGatePassed } from "@/lib/gate-request";
import { getAiHintIds, getHintNotice, getViewerHints } from "@/lib/hint-store";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";
import TeamlessNotice from "@/components/teamless-notice";
import { submitAiFlagAction } from "./actions";

const DEFAULT_TITLE = "AI";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (!(await isModuleLive("ai"))) return {};
  const { id } = await params;
  const challenge = (await listAiChallenges()).find((c) => c.id === decodeURIComponent(id));
  if (!challenge) return {};
  return {
    title: challenge.title,
    // The description is challenge CONTENT (may carry markdown, links, the
    // organizer's phrasing) — the meta description stays a neutral frame.
    description: `${challenge.category} · ${challenge.points} points.`,
  };
}

export default async function AiChallengePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleLive("ai"))) notFound();

  // THE PRE-EVENT GATE, ENFORCED HERE RATHER THAN INHERITED. proxy.ts covers
  // page routes with `GATED_ROUTES.has(pathname)` — an EXACT match over the
  // registry's nav hrefs, so it gates `/ai` and never `/ai/<id>`. This is the
  // one route that mints a launch token, and §6.6's contract (the API routes
  // never re-check the gate, because a token in hand proves it passed) is
  // only true if the check happens before the mint. So it happens here, in
  // the page, above every load below — and again in ./actions.ts, which is
  // the other way in. Same destination proxy.ts sends a gated visitor to;
  // /gate's own redirect keys on the complement, so this cannot loop.
  if (!(await requireGatePassed())) redirect("/gate");

  const { id } = await params;
  const challengeId = decodeURIComponent(id);

  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  const viewerIsAdmin = await isAdminLogin(login);

  // Same order as /ai and /flags/[id]: the team redirect fires before the
  // loads below, so a teamless contestant is never bounced after work that
  // gets thrown away.
  // `true` only for an admin let through without a team (issue #357):
  // the notice below is the half of that exemption that was missing.
  const viewerIsTeamless = await redirectIfTeamless(login, { isAdmin: viewerIsAdmin });

  const [challenges, solveCounts, viewerAi, modules, hintIds, hintNotice, viewerHints] = await Promise.all([
    listAiChallenges(),
    getAiSolveCounts(),
    login ? getViewerAi(login) : Promise.resolve<ViewerAi>({ solved: {}, attempts: {} }),
    getResolvedModules(),
    getAiHintIds(),
    getHintNotice(),
    // The viewer's owned hint TEXT renders server-side — the reveal button
    // only exists while there is something left to buy. Mirrors flags/[id].
    login ? getViewerHints(login) : Promise.resolve(null),
  ]);

  const challenge = challenges.find((c) => c.id === challengeId);
  if (!challenge) notFound();

  const moduleTitle = modules.find((m) => m.id === "ai")?.title ?? DEFAULT_TITLE;
  const cooldownMs = AI_COOLDOWN_SEC * 1000;

  // Field by field, never a spread — a spread of the store record is how a
  // secret (or a field this page never meant to expose, like `urlTemplate`
  // or `mode`, both of which are read directly off `challenge` below instead
  // of through this view) would leak. Same discipline as /ai's board.
  const view: ChallengeView = {
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    description: challenge.description,
    points: challenge.points,
    solveCount: solveCounts.get(challenge.id) ?? 0,
    caseSensitive: challenge.caseSensitive,
    ...deriveStatus(viewerAi.solved[challenge.id], viewerAi.attempts[challenge.id], cooldownMs),
  };

  // THE MINT. Reached only for a signed-in viewer — there is no code path
  // above that calls this without `login` in hand, and a signed-out visitor
  // gets the sign-in prompt below instead. `challenges` is the FULL public
  // board (the token's progress array draws from every challenge, not just
  // this one); `challenge` and `viewerAi` are exactly what was just built
  // above, nothing re-fetched or reshaped for the mint.
  const launchUrl = login
    ? await mintLaunchUrl({ origin: resolveOrigin(), login, challenge, challenges, viewer: viewerAi })
    : null;

  return (
    <div className="flex flex-col gap-6">
      {viewerIsTeamless && <TeamlessNotice what="solves" />}
      <div className="flex flex-col gap-3">
        <Link href="/ai" className="ds-link w-fit text-sm">
          ← {moduleTitle}
        </Link>
        <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#14b8a6]">
          {challenge.category}
        </p>
        <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {challenge.title}
        </h1>
      </div>

      <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
        {launchUrl ? (
          <div className="flex flex-col gap-1">
            {/* This is the ONE place a token-bearing URL is ever rendered —
                a single anchor's href, nothing else on the page touches it. */}
            <a
              href={launchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ds-link w-fit text-sm font-semibold"
            >
              Open challenge →
            </a>
            <p className="text-xs text-muted">This link is yours — it signs you in on the challenge site.</p>
          </div>
        ) : (
          <p className="text-xs text-muted">Sign in with GitHub to get your personal challenge link.</p>
        )}
      </div>

      {/* Paid hint (issue #211): mirrors flags/[id]'s block exactly — the
          owned text renders server-side, the buy button (client) exists only
          while unowned, hints are on, and the viewer is signed in. Sits
          OUTSIDE the `challenge.mode !== "event"` gate below, on purpose: a
          hint about an externally hosted challenge is still a hint, and the
          launcher-only layout keeps the same slot for it. */}
      {hintNotice.active && hintIds.includes(challenge.id) && (
        <div className="max-w-xl">
          {viewerHints?.ai[challenge.id] ? (
            <p className="rounded border-l-2 border-[#d4a017]/50 bg-[#d4a017]/[0.06] px-3 py-2 text-sm leading-relaxed text-[#d4a017]/90">
              💡 {viewerHints.ai[challenge.id]}
            </p>
          ) : login ? (
            <HintRevealButton app="ai" id={challenge.id} cost={hintNotice.cost} />
          ) : (
            <p className="text-xs text-muted">
              This one has a paid hint ({hintNotice.cost} pts) — sign in to reveal it.
            </p>
          )}
        </div>
      )}

      {/* Event-only challenges have no in-box form at all — the launcher
          above is the whole page for them. flag/both render the same shared
          component classic's own page uses.

          NOT `submitPath="/api/ai/submit"`: that route is the EXTERNAL
          surface and authenticates a launch token, which lives only in the
          href above and must not reach the client any other way (spec §7, and
          §6.1's 2026-09-02 amendment). The in-box form goes through the
          Server Action beside this file instead — session-authenticated, and
          it re-runs every gate this render just ran. The id is bound here so
          the client-side prop is just `(flag) => …`; the action re-validates
          it regardless. */}
      {challenge.mode !== "event" && (
        <ChallengeDetail
          challenge={view}
          authenticated={Boolean(login)}
          submitAction={submitAiFlagAction.bind(null, challenge.id)}
        />
      )}
    </div>
  );
}
