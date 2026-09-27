import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logActivity } from "@/lib/activity-log";
import { launchApiAccess } from "@/lib/launch";
import { CLASSIC_ID_RE, submitFlag } from "@/lib/classic-store";
import { hasTeam } from "@/lib/team-store";

/** Hard cap on a submitted flag's length, checked BEFORE the store ever sees
 *  it. A flag is never more than a short token in practice; this exists only
 *  to stop an oversized body from being pipelined into Redis/Lua at all. */
const FLAG_MAX_LEN = 512;

/**
 * Submits one flag against one classic challenge.
 *
 * `submitFlag` is authoritative on the pause/schedule gate, the already-
 * solved guard, the cooldown, and the grading itself (its Lua script
 * re-checks everything atomically) — this route never re-implements or
 * second-guesses that enforcement. It only derives `login` from the session
 * (never the request body — a body-supplied login would be an account-
 * impersonation hole) and maps the store's result to a status code:
 *   - unauthenticated -> 401
 *   - session with no GitHub login -> 400
 *   - event not launched (and not an admin) -> 403 { error: "not-launched" }
 *   - malformed challengeId/flag -> 400
 *   - unknown/deleted challenge -> 404
 *   - gate refusal (paused/solved/cooldown/unavailable) -> 403
 *   - grading script failure -> 503
 *   - success -> 200
 *
 * The pre-launch lock (#464) runs after authentication (so an unauthenticated
 * caller still gets the more specific 401) and before `submitFlag` is ever
 * called — a refusal here can never follow a write that already happened.
 * See `requireLaunchedApi` (apps/web/src/lib/launch.ts).
 *
 * Validating `challengeId` against `CLASSIC_ID_RE` here, before the store
 * call, is what lets a store-reported `"invalid"` mean "unknown challenge"
 * (404) rather than "malformed" (400) — this route has already ruled out the
 * shape problem by the time it calls `submitFlag`.
 *
 * No response from this route can ever reveal the submitted flag or a stored
 * one: `SubmitResult` (classic-store's return type) never carries either, by
 * construction — there is no field here to leak.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = (session.user as { login?: string }).login;
  if (!login) return NextResponse.json({ error: "session has no GitHub login" }, { status: 400 });

  // #464 pre-launch lock. Its own refusal — 403 `not-launched` — never a
  // wrong-answer shape. An admin before launch passes as a PREVIEW, and their
  // flag is graded as a dry run: the same script, writing nothing.
  const { refused, preview } = await launchApiAccess(login);
  if (refused) return refused;

  // Scoring is per team, and a teamless login's banked points fold into no
  // team total (issue #153). Refused here, AFTER the launch lock (a pre-launch lockout
  // is the more fundamental "not yet") and BEFORE `submitFlag`, so the refusal
  // can never follow a write that already happened — the same ordering rule
  // the launch check above follows. `hasTeam` fails OPEN, so a Redis blip lets
  // the flag through rather than dropping it.
  //
  // This runs before the body is even parsed, so a teamless caller cannot use
  // the response to distinguish a correct flag from a wrong one.
  if (!(await hasTeam(login))) {
    return NextResponse.json({ error: "no-team" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
  const flag = typeof body.flag === "string" ? body.flag : "";
  if (!CLASSIC_ID_RE.test(challengeId) || !flag.trim() || flag.length > FLAG_MAX_LEN) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const result = await submitFlag(login, challengeId, flag, { dryRun: preview });
  if (result.ok) {
    if (!result.correct) return NextResponse.json({ correct: false });
    // Activity log (issue #212): fresh solves only — an idempotent
    // re-submission banked nothing and would double-count the event. The id,
    // never the flag; logActivity is fail-open, so it cannot fail a solve
    // that already landed.
    if (!result.already) await logActivity("classic-solve", login, challengeId);
    // `already` (this login had banked this flag before — see SubmitResult)
    // rides along so the client can say so, instead of reading the
    // accompanying `points: 0` as an award of nothing.
    return result.already
      ? NextResponse.json({ correct: true, points: result.points, already: true })
      : NextResponse.json({ correct: true, points: result.points });
  }

  if (result.reason === "invalid") {
    return NextResponse.json({ error: "challenge not found" }, { status: 404 });
  }
  if (result.reason === "error") {
    return NextResponse.json({ error: "classic grading failed" }, { status: 503 });
  }
  // paused | solved | cooldown | unavailable
  const retryAt = "retryAt" in result ? result.retryAt : undefined;
  return NextResponse.json(retryAt ? { error: result.reason, retryAt } : { error: result.reason }, { status: 403 });
}
