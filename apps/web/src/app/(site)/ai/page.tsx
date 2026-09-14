// Server Component: reads the session and the ai module's public-safe data
// (`listAiChallenges()` never returns a flag, a hint or a signing key — see
// ai-store.ts), then derives each challenge's PER-VIEWER status server-side
// and hands a plain view model down to <ChallengeBoard>. Data (and auth) in,
// interactivity down — same split as classic's /flags/page.tsx, which this
// mirrors structurally.
//
// Gated on the module registry rather than on auth: this route only exists at
// all when the ai module is enabled (module contract §5.4), so an event
// without it 404s here exactly like any other unknown route. Session is
// optional — a signed-out visitor can still browse the board; only opening a
// challenge (its own page) mints anything, and only submitting a flag
// requires auth, enforced by /api/ai/submit itself.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ModuleEmptyState from "@/components/module-empty-state";
import PageHeader from "@/components/page-header";
import ChallengeBoard, { type ChallengeView } from "@/components/challenge-board";
import { deriveStatus } from "@/lib/derive-status";
import { isAdminLogin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { getAdminSettings } from "@/lib/admin-store";
import {
  AI_COOLDOWN_SEC,
  getAiSolveCounts,
  getViewerAi,
  listAiCategories,
  listAiChallenges,
  type ViewerAi,
} from "@/lib/ai-store";
import { isModuleLive } from "@/lib/enabled-modules";
import { getAiHintIds } from "@/lib/hint-store";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";

const DEFAULT_TITLE = "AI";
const DEFAULT_BLURB = "Prompt-injection and guardrail challenges hosted outside the box, scored inside it.";

// `metadata` is a static export and cannot await Redis for the organizer's
// resolved title, so this is `generateMetadata` instead — see
// resolved-modules.ts for why every consumer of it renders dynamically.
export async function generateMetadata(): Promise<Metadata> {
  const mod = (await getResolvedModules()).find((m) => m.id === "ai");
  return {
    title: mod?.title ?? DEFAULT_TITLE,
    description: mod?.blurb ?? DEFAULT_BLURB,
  };
}

export default async function AiPage() {
  if (!(await isModuleLive("ai"))) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  // Drives the empty state's authoring route and the team-redirect exemption
  // below — same check `/admin` and every `/api/admin/*` route gate on, so a
  // link is never offered to someone the admin page would then 403 at.
  // Mirrors flags/page.tsx.
  const viewerIsAdmin = await isAdminLogin(login);

  // Solves only count for a team (issue #153), and the submit/mint paths
  // refuse a teamless login. Sending them to set a team up first means
  // nobody learns that by opening a challenge and finding it doesn't count.
  // Before the loads below, so a redirect never follows work that was
  // thrown away.
  await redirectIfTeamless(login, { isAdmin: viewerIsAdmin });

  const [challenges, categories, solveCounts, viewerAi, settings, modules, hintIds] = await Promise.all([
    listAiChallenges(),
    listAiCategories(),
    getAiSolveCounts(),
    login ? getViewerAi(login) : Promise.resolve<ViewerAi>({ solved: {}, attempts: {} }),
    // Fails OPEN, same doctrine as ai-store.ts's own resolveSettings for this
    // exact read: a Redis blip here must not take the whole public board
    // down over a cooldown override, so a rejected settings read falls back
    // to `null` (-> the module default below) rather than failing the page.
    getAdminSettings().catch(() => null),
    getResolvedModules(),
    getAiHintIds(),
  ]);

  const mod = modules.find((m) => m.id === "ai");
  const moduleTitle = mod?.title ?? DEFAULT_TITLE;
  // The organizer-editable blurb, which is the MODULE's own description of
  // itself and belongs in the page's lede — see flags/page.tsx's identical
  // note on why this must never be read off the registry default directly.
  const blurb = mod?.blurb ?? DEFAULT_BLURB;

  const cooldownMs = (settings?.aiCooldownSec ?? AI_COOLDOWN_SEC) * 1000;

  // Built field by field from the public `AiChallenge` shape plus this
  // challenge's solve count and this viewer's derived status — never a
  // spread of a raw store record, which is how a flag (or a signing key)
  // would leak. `AiChallenge` also carries `urlTemplate` and `mode`, but the
  // board tile doesn't render either — those belong to the challenge's own
  // page — so they are deliberately left off this view model too.
  const viewChallenges: ChallengeView[] = challenges.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    description: c.description,
    points: c.points,
    solveCount: solveCounts.get(c.id) ?? 0,
    // Listed explicitly, like every field above it — this map is deliberately
    // NOT a spread of the store record, because a spread is how a secret leaks.
    caseSensitive: c.caseSensitive,
    ...deriveStatus(viewerAi.solved[c.id], viewerAi.attempts[c.id], cooldownMs),
  }));

  // Per-VIEWER state, so it sits above the board rather than in the header.
  // Signed in, the board's "Your run" rail carries the solved and point
  // totals — a sentence restating the same numbers directly above it was the
  // same fact twice (the duplication flags/page.tsx also avoids). Only the
  // signed-out prompt has no rail to defer to.
  const progress = login ? null : "Sign in with GitHub to play the challenges.";

  return (
    <div className="flex flex-col gap-8">
      {/* The eyebrow names WHAT THE PAGE LISTS, the title names the module —
          see flags/page.tsx's identical note on why eyebrow={moduleTitle}
          would read as a template slip rather than a kicker. */}
      <PageHeader eyebrow="Challenge board" title={moduleTitle} description={blurb} />
      {/* The progress line sits OUTSIDE the empty-state branch on purpose —
          see flags/page.tsx's identical note. Nesting it inside a
          `challenges.length > 0` branch would quietly take the "Sign in with
          GitHub" prompt away from a signed-out visitor looking at a board
          whose challenges haven't been authored yet. */}
      <div className="flex flex-col gap-4">
        {progress && <p className="text-sm text-zinc-400">{progress}</p>}
        {challenges.length === 0 ? (
          <ModuleEmptyState
            message={
              viewerIsAdmin
                ? "No challenges yet. Add the first one from the admin panel."
                : "No challenges are available yet. Check back soon."
            }
            authoring={viewerIsAdmin ? { href: "/admin?tab=ai", label: "Author challenges" } : null}
          />
        ) : (
          <ChallengeBoard
            categories={categories}
            challenges={viewChallenges}
            authenticated={Boolean(login)}
            hintIds={hintIds}
            basePath="/ai"
          />
        )}
      </div>
    </div>
  );
}
