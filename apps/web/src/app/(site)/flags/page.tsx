// Server Component: reads the session and the classic module's public-safe
// data (`listChallenges()` never returns a flag, in either form — see
// classic-store.ts), then derives each challenge's PER-VIEWER status
// server-side and hands a plain view model down to <ChallengeBoard>. Data (and
// auth) in, interactivity down — same split as quiz/page.tsx.
//
// Gated on the module registry rather than on auth: this route only exists at
// all when the classic module is enabled (module contract §5.4), so an event
// without it 404s here exactly like any other unknown route. Session is
// optional — a signed-out visitor can still see the challenges, same as the
// public leaderboard; only submitting requires auth, enforced by
// /api/classic/submit itself.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ModuleEmptyState from "@/components/module-empty-state";
import PageHeader from "@/components/page-header";
import ChallengeBoard, { type ClassicChallengeView } from "@/components/challenge-board";
import { deriveStatus } from "@/lib/derive-status";
import { isAdminLogin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { getAdminSettings } from "@/lib/admin-store";
import {
  CLASSIC_COOLDOWN_SEC,
  getSolveCounts,
  getViewerClassic,
  listCategories,
  listChallenges,
  type ViewerClassic,
} from "@/lib/classic-store";
import { isModuleLive } from "@/lib/enabled-modules";
import { getClassicHintIds } from "@/lib/hint-store";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";

const DEFAULT_TITLE = "Jeopardy";
const DEFAULT_BLURB = "Find the flag, submit the string, take the points.";

// `metadata` is a static export and cannot await Redis for the organizer's
// resolved title, so this is `generateMetadata` instead — see
// resolved-modules.ts for why every consumer of it renders dynamically.
export async function generateMetadata(): Promise<Metadata> {
  const mod = (await getResolvedModules()).find((m) => m.id === "classic");
  return {
    title: mod?.title ?? DEFAULT_TITLE,
    description: mod?.blurb ?? DEFAULT_BLURB,
  };
}

export default async function FlagsPage() {
  if (!(await isModuleLive("classic"))) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  // Drives the empty state's authoring route only — same check `/admin` and
  // every `/api/admin/*` route gate on, so a link is never offered to someone
  // the admin page would then 403 at. Mirrors quiz/page.tsx.
  const viewerIsAdmin = await isAdminLogin(login);

  // Solves only count for a team (issue #153), and the submit route refuses a
  // teamless login. Sending them to set a team up first means nobody learns
  // that by submitting a flag and watching it not count. Before the loads
  // below, so a redirect never follows work that was thrown away.
  await redirectIfTeamless(login, { isAdmin: viewerIsAdmin });

  const [challenges, categories, solveCounts, viewerClassic, settings, modules, hintIds] = await Promise.all([
    listChallenges(),
    listCategories(),
    getSolveCounts(),
    login ? getViewerClassic(login) : Promise.resolve<ViewerClassic>({ solved: {}, attempts: {} }),
    // Fails OPEN, same doctrine as ai-store.ts's resolveSettings for this
    // exact read (see ai/page.tsx's identical fix): a Redis blip here must
    // not take the whole public board down over a cooldown override, so a
    // rejected settings read falls back to `null` (-> the module default
    // below) rather than failing the page.
    getAdminSettings().catch(() => null),
    getResolvedModules(),
    getClassicHintIds(),
  ]);

  const mod = modules.find((m) => m.id === "classic");
  const moduleTitle = mod?.title ?? DEFAULT_TITLE;
  // The organizer-editable blurb, which is the MODULE's own description of
  // itself and belongs in the page's lede — see quiz/page.tsx's identical
  // note on why this must never be read off the registry default directly.
  const blurb = mod?.blurb ?? DEFAULT_BLURB;

  const cooldownMs = (settings?.classicCooldownSec ?? CLASSIC_COOLDOWN_SEC) * 1000;

  // Built field by field from the public `Challenge` shape plus this
  // challenge's solve count and this viewer's derived status — never a
  // spread of a raw store record, which is how a flag would leak.
  const viewChallenges: ClassicChallengeView[] = challenges.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    description: c.description,
    points: c.points,
    solveCount: solveCounts.get(c.id) ?? 0,
    // Listed explicitly, like every field above it — this map is deliberately
    // NOT a spread of the store record, because a spread is how a flag leaks.
    caseSensitive: c.caseSensitive,
    ...deriveStatus(viewerClassic.solved[c.id], viewerClassic.attempts[c.id], cooldownMs),
  }));

  // Per-VIEWER state, so it sits above the board rather than in the header.
  // Signed in, the board's "Your run" rail carries the solved and point
  // totals — a sentence restating the same numbers directly above it was the
  // same fact twice (the duplication quiz/page.tsx also removed). Only the
  // signed-out prompt has no rail to defer to.
  const progress = login ? null : "Sign in with GitHub to submit flags.";

  return (
    <div className="flex flex-col gap-8">
      {/* The eyebrow names WHAT THE PAGE LISTS, the title names the module —
          eyebrow={moduleTitle} rendered the same words twice, stacked
          ("QUIZ" over "Quiz"), which read as a template slip rather than a
          kicker (issue #200, tier 4). Same pattern as /challenges' own
          "Targets" eyebrow, and it stays accurate whatever the organizer
          renames the module to. */}
      <PageHeader eyebrow="Flag board" title={moduleTitle} description={blurb} />
      {/* The progress line sits OUTSIDE the empty-state branch on purpose —
          see quiz/page.tsx's identical note. Nesting it inside a
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
            authoring={viewerIsAdmin ? { href: "/admin?tab=classic", label: "Author challenges" } : null}
          />
        ) : (
          <ChallengeBoard
            categories={categories}
            challenges={viewChallenges}
            authenticated={Boolean(login)}
            hintIds={hintIds}
            basePath="/flags"
          />
        )}
      </div>
    </div>
  );
}
