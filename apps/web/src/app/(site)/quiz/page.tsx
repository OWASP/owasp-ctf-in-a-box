// Server Component: reads the session and the quiz's public-safe data
// (`listQuestions()` never returns an answer key — see quiz-store.ts), then
// derives each question's PER-VIEWER status server-side and hands a plain
// view model down to <QuizBoard>. Data (and auth) in, interactivity down —
// same split as leaderboard/page.tsx.
//
// Gated on the module registry rather than on auth: this route only exists
// at all when the quiz module is enabled (module contract §5.4), so an
// event without the quiz module 404s here exactly like any other unknown
// route. Session is optional — a signed-out visitor can still see the
// questions, same as the public leaderboard; only submitting requires auth,
// enforced by /api/quiz/answer itself.

import type { Metadata } from "next";
import PreviewBanner from "@/components/preview-banner";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ModuleEmptyState from "@/components/module-empty-state";
import PageHeader from "@/components/page-header";
import QuizBoard, { type QuizQuestionView, type QuizStatus } from "@/components/quiz-board";
import { isAdminLogin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { getAdminSettings } from "@/lib/admin-store";
import { isModuleLive } from "@/lib/enabled-modules";
import { redirectIfNotLaunched } from "@/lib/launch";
import { getResolvedModules } from "@/lib/resolved-modules";
import { redirectIfTeamless } from "@/lib/require-team";
import TeamlessNotice from "@/components/teamless-notice";
import { getViewerQuiz, listQuestions, QUIZ_MAX_ATTEMPTS, QUIZ_RETRY_AFTER_MIN, type ViewerQuiz } from "@/lib/quiz-store";

// `metadata` is a static export and cannot await Redis for the organizer's
// resolved title, so this is `generateMetadata` instead — see
// resolved-modules.ts for why every consumer of it renders dynamically.
export async function generateMetadata(): Promise<Metadata> {
  const mod = (await getResolvedModules()).find((m) => m.id === "quiz");
  return {
    title: mod?.title ?? "Quiz",
    description: mod?.blurb ?? "Answer security questions for points.",
  };
}

/** Derives this viewer's status for one question from the SAME cap/cooldown
 *  rule quiz-store's `evaluateGate` enforces authoritatively at submit time
 *  — reimplemented here purely for display, using data this page already
 *  has (one `getViewerQuiz` pipeline + the current admin settings) instead
 *  of an extra `quizGate` round trip per question. A stale or drifted read
 *  here is a display nit at worst: `answerQuestion`'s Lua script re-checks
 *  both, atomically, against fresh state, and is the only thing that
 *  actually enforces the cap or the cooldown.
 *
 *  `now` defaults to `Date.now()` (read here, in a plain helper, rather than
 *  in the page component's own body) — same reason `formatRelativeTime`
 *  takes `now` as a parameter: a Server Component's render function must
 *  stay a pure function of its props for React's rules (no impure
 *  `Date.now()`/`Math.random()` calls in the component body itself). */
function deriveStatus(
  answered: ViewerQuiz["answered"][string] | undefined,
  attempt: ViewerQuiz["attempts"][string] | undefined,
  maxAttempts: number,
  cooldownMs: number,
  now: number = Date.now(),
): QuizStatus {
  if (answered) return { status: "answered", earnedPoints: answered.points };

  const attemptsSoFar = attempt?.attempts ?? 0;
  if (maxAttempts > 0 && attemptsSoFar >= maxAttempts) return { status: "exhausted" };

  if (cooldownMs > 0 && attempt) {
    const lastMs = Date.parse(attempt.lastAt);
    if (Number.isFinite(lastMs)) {
      const retryAtMs = lastMs + cooldownMs;
      if (now < retryAtMs) return { status: "cooldown", retryAt: new Date(retryAtMs).toISOString() };
    }
  }

  return { status: "unanswered" };
}

export default async function QuizPage() {
  if (!(await isModuleLive("quiz"))) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  // #464 pre-launch lock: before ANY content load below. A refused viewer
  // (not launched, not an admin) goes to the landing page.
  const launch = await redirectIfNotLaunched(login);
  // Drives the empty state's authoring route only. Deliberately the SAME
  // check `/admin` and every `/api/admin/*` route gate on, so this can never
  // offer a link to someone the admin page would then 403 at.
  const viewerIsAdmin = await isAdminLogin(login);

  // Answers only count for a team (issue #153), and the answer route refuses a
  // teamless login. Sending them to set a team up first means nobody learns
  // that by answering a question and watching it not count. Before the loads
  // below, so a redirect never follows work that was thrown away.
  // `true` only for an admin let through without a team (issue #357):
  // the notice below is the half of that exemption that was missing.
  const viewerIsTeamless = await redirectIfTeamless(login, { isAdmin: viewerIsAdmin });

  const [questions, viewerQuiz, settings, modules] = await Promise.all([
    listQuestions(),
    login ? getViewerQuiz(login) : Promise.resolve<ViewerQuiz>({ answered: {}, attempts: {} }),
    getAdminSettings(),
    getResolvedModules(),
  ]);

  const mod = modules.find((m) => m.id === "quiz");
  const moduleTitle = mod?.title ?? "Quiz";
  // The organizer-editable blurb, which is the MODULE's own description of
  // itself and belongs in the page's lede. It used to reach `generateMetadata`
  // and nothing else, so an organizer could edit it, save, and see the page
  // they were looking at not change at all.
  const blurb = mod?.blurb ?? "Answer security questions for points.";

  const maxAttempts = settings.quizMaxAttempts ?? QUIZ_MAX_ATTEMPTS;
  const cooldownMs = (settings.quizRetryAfterMin ?? QUIZ_RETRY_AFTER_MIN) * 60_000;

  // Built field by field from the public `Question` shape — never a spread
  // of a raw store record, which is how an answer key would leak.
  const viewQuestions: QuizQuestionView[] = questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    type: q.type,
    choices: q.choices,
    points: q.points,
    // Read from the SAME attempts row `deriveStatus` gates on, so the
    // "2 of 3 attempts left" chip and the exhausted state can never disagree.
    attemptsUsed: viewerQuiz.attempts[q.id]?.attempts ?? 0,
    ...deriveStatus(viewerQuiz.answered[q.id], viewerQuiz.attempts[q.id], maxAttempts, cooldownMs),
  }));

  // Per-VIEWER state, so it sits above the board rather than in the header.
  // Signed in, the board's own progress strip (answered/total, points, bar)
  // carries the count — a sentence saying the same numbers directly above it
  // was the same fact twice, the duplication the classic board already
  // removed. Only the signed-out prompt has no strip to defer to.
  const progress = login ? null : "Sign in with GitHub to answer questions.";

  return (
    <div className="flex flex-col gap-8">
      {/* #464: an admin browsing before launch sees what contestants will. */}
      {launch.preview && <PreviewBanner />}
      {/* The eyebrow names WHAT THE PAGE LISTS, the title names the module —
          eyebrow={moduleTitle} rendered the same words twice, stacked
          ("QUIZ" over "Quiz"), which read as a template slip rather than a
          kicker (issue #200, tier 4). Same pattern as /challenges' own
          "Targets" eyebrow, and it stays accurate whatever the organizer
          renames the module to. */}
      {viewerIsTeamless && <TeamlessNotice what="answers" />}
      <PageHeader eyebrow="Questions" title={moduleTitle} description={blurb} />
      {/* The progress line sits OUTSIDE the empty-state branch on purpose. It
          used to be the header description, which rendered whatever the
          question count was; moving it into the populated branch quietly took
          the "Sign in with GitHub" prompt away from a signed-out visitor
          looking at a quiz whose questions haven't been authored yet — exactly
          the visitor most worth telling, since signing in now is what lets
          them answer the moment questions appear. */}
      <div className="flex flex-col gap-4">
        {progress && <p className="text-sm text-zinc-400">{progress}</p>}
        {questions.length === 0 ? (
          <ModuleEmptyState
            message={
              viewerIsAdmin
                ? "No quiz questions yet. Add the first one from the admin panel."
                : "No quiz questions are available yet. Check back soon."
            }
            authoring={viewerIsAdmin ? { href: "/admin?tab=quiz", label: "Author questions" } : null}
          />
        ) : (
          <QuizBoard questions={viewQuestions} authenticated={Boolean(login)} maxAttempts={maxAttempts} />
        )}
      </div>
    </div>
  );
}
