import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logActivity } from "@/lib/activity-log";
import { launchApiAccess } from "@/lib/launch";
import { answerQuestion, QUIZ_ID_RE } from "@/lib/quiz-store";
import { hasTeam } from "@/lib/team-store";

/** Validating against `quiz-store`'s own exported `QUIZ_ID_RE` (rather than
 *  a local copy) rejects a malformed request here, before it ever reaches
 *  `answerQuestion`, and keeps a single source of truth for the pattern —
 *  a local copy could silently desync if the store's ever changed. Because
 *  of that upfront check, any `"invalid"` reason the store itself returns
 *  can only mean the question id doesn't exist (GRADE_SCRIPT's "missing"
 *  branch) — not a shape problem this route already ruled out — which is
 *  what lets this route tell "malformed" (400) apart from "unknown
 *  question" (404) even though the store reports both under the same
 *  reason string. */
function isChoiceList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === "string" && QUIZ_ID_RE.test(c));
}

/**
 * Submits a graded answer for one quiz question.
 *
 * `answerQuestion` is authoritative on the attempt cap, cooldown, and
 * grading (its Lua script re-checks everything atomically) — this route
 * never re-implements or second-guesses that enforcement. It only derives
 * `login` from the session (never the request body) and maps the store's
 * result to a status code:
 *   - unauthenticated -> 401
 *   - session with no GitHub login -> 400
 *   - event not launched (and not an admin) -> 403 { error: "not-launched" }
 *   - malformed questionId/choices -> 400
 *   - unknown/missing question -> 404
 *   - gate refusal (paused/answered/exhausted/cooldown/unavailable) -> 403
 *   - grading script failure -> 503
 *   - success -> 200
 *
 * The pre-launch lock (#464) runs after authentication (so an unauthenticated
 * caller still gets the more specific 401) and before `answerQuestion` is
 * ever called — a refusal here can never follow a write that already
 * happened. See `requireLaunchedApi` (apps/web/src/lib/launch.ts).
 *
 * No response from this route can ever reveal the correct choice ids:
 * `AnswerResult` (quiz-store's return type) never carries them, by
 * construction — there is no field here to leak.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = (session.user as { login?: string }).login;
  if (!login) return NextResponse.json({ error: "session has no GitHub login" }, { status: 400 });

  // #464 pre-launch lock. Its own refusal — 403 `not-launched` — never a
  // wrong-answer shape. An admin before launch passes as a PREVIEW, and their
  // answer is graded as a dry run: the same script, writing nothing.
  const { refused, preview } = await launchApiAccess(login);
  if (refused) return refused;

  // Scoring is per team, and a teamless login's banked points fold into no
  // team total (issue #153). Refused here, AFTER the launch lock (a pre-launch lockout
  // is the more fundamental "not yet") and BEFORE `answerQuestion`, so the
  // refusal can never follow a write that already happened — the same ordering
  // rule the launch check above follows. `hasTeam` fails OPEN, so a Redis blip
  // lets the answer through rather than dropping it.
  if (!(await hasTeam(login))) {
    return NextResponse.json({ error: "no-team" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const questionId = typeof body.questionId === "string" ? body.questionId : "";
  const choices = body.choices;
  if (!QUIZ_ID_RE.test(questionId) || !isChoiceList(choices)) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const result = await answerQuestion(login, questionId, choices, { dryRun: preview });
  if (result.ok) {
    if (!result.correct) return NextResponse.json({ correct: false });
    // Activity log (issue #212): fresh solves only — an idempotent
    // re-submission banked nothing. The question id, never the choices;
    // logActivity is fail-open, so it cannot fail an answer that already
    // landed.
    if (!result.already) await logActivity("quiz-solve", login, questionId);
    // `already` (this login had banked this question before — see
    // AnswerResult) rides along so the client can say so, instead of
    // reading the accompanying `points: 0` as an award of nothing.
    return result.already
      ? NextResponse.json({ correct: true, points: result.points, already: true })
      : NextResponse.json({ correct: true, points: result.points });
  }

  if (result.reason === "invalid") {
    return NextResponse.json({ error: "question not found" }, { status: 404 });
  }
  if (result.reason === "error") {
    return NextResponse.json({ error: "quiz grading failed" }, { status: 503 });
  }
  // paused | answered | exhausted | cooldown | unavailable
  const retryAt = "retryAt" in result ? result.retryAt : undefined;
  return NextResponse.json(retryAt ? { error: result.reason, retryAt } : { error: result.reason }, { status: 403 });
}
