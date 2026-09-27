"use server";

// The in-box flag form's server half — spec §6.1's 2026-09-02 amendment.
//
// WHY THIS EXISTS RATHER THAN A FETCH. `/api/ai/submit` is the EXTERNAL
// surface: it identifies its caller by the launch token in the body, is
// cookie-blind, CORS-open and exempt from the app's same-origin check
// (`proxy.ts`'s `AI_PREFIX`) precisely because it reads no cookie. The token
// it wants exists in exactly one place — the launcher's href — and §7 keeps
// it there, so the form on `/ai/[id]` has nothing to authenticate with and
// cannot call that route at all. A Server Action is the other half of the
// same design: identity comes from the session cookie, the token is never
// materialised on the client, and the action sits OUTSIDE the `/api/ai/`
// CSRF exemption, so Next's own server-action origin enforcement applies to
// the cookie it reads.
//
// THIS IS A SECURITY BOUNDARY, NOT A CONVENIENCE WRAPPER. A Server Action is
// a POST endpoint with a generated id: anything that can reach the page can
// reach it directly, so it re-checks every gate the page's render checked,
// in the page's own order — module live, session, pre-launch lock, team —
// before the store is touched. Nothing here may return (or import) anything
// carrying a token, a flag or a signing key; `SubmitResponse` has no field
// one could ride in.
//
// The team check is `hasTeam`, not `redirectIfTeamless`: an action answers
// the form it was called from, and a redirect thrown at a `fetch`-style call
// is not an answer. It also takes NO admin exemption — matching
// `api/ai/submit/route.ts` and `api/classic/submit/route.ts`, which are the
// boundary that actually holds; `require-team.ts` documents why the page-level
// exemption is not a scoring hole.

import { headers } from "next/headers";

import type { SubmitResponse } from "@/components/challenge-detail";
import { logActivity } from "@/lib/activity-log";
import { AI_ID_RE } from "@/lib/ai-keys";
import { submitAiFlag, type AiSubmitResult } from "@/lib/ai-store";
import { auth } from "@/lib/auth";
import { isModuleLive } from "@/lib/enabled-modules";
import { getLaunchAccess } from "@/lib/launch";
import { hasTeam } from "@/lib/team-store";

/** Hard cap on a submitted flag's length, checked BEFORE the store ever sees
 *  it — the same cap `api/ai/submit/route.ts` puts on the external path. */
const FLAG_MAX_LEN = 512;

/** `AiSubmitResult` -> the wire shape `ChallengeDetail` renders, mapped
 *  EXACTLY as `aiAwardResponse` (ai-http.ts) maps it for the external route,
 *  so the two paths cannot describe the same outcome differently. `dryRun` is
 *  deliberately absent: `submitAiFlag` never produces one. */
function toResponse(result: AiSubmitResult): SubmitResponse {
  if (result.ok) {
    if (!result.correct) return { correct: false };
    // `already` rides along defaulted rather than omitted, same as the route:
    // a caller must never have to read a missing key as "false" itself.
    return { correct: true, points: result.points, already: result.already ?? false };
  }
  if (result.reason === "cooldown" && result.retryAt) return { error: "cooldown", retryAt: result.retryAt };
  return { error: result.reason };
}

/**
 * Grades one typed flag for one ai challenge, as the signed-in session.
 *
 * Bound to the challenge id by the page (`.bind(null, challenge.id)`), so the
 * client-side prop is `(flag) => Promise<SubmitResponse>`. The id is still
 * re-validated here — a bound argument travels through the client and is an
 * input like any other.
 *
 * Order is load-bearing and mirrors the page's render: the module check runs
 * before the session is read (a disabled module is not a way to probe a
 * cookie), the pre-launch lock (#464) needs the login so it comes right
 * after, and every check runs before `submitAiFlag`, so a refusal
 * can never follow a write. `submitAiFlag` stays authoritative on pause,
 * cooldown, already-solved and grading — its Lua script re-checks all of it
 * atomically; nothing above re-implements any of that.
 */
export async function submitAiFlagAction(challengeId: string, flag: string): Promise<SubmitResponse> {
  if (!(await isModuleLive("ai"))) return { error: "unavailable" };

  const session = await auth.api.getSession({ headers: await headers() });
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!login) return { error: "unauthorized" };

  // #464 pre-launch lock, CLOSED on uncertainty (getLaunchAccess never
  // throws: a failed read counts as "not launched"), and the opposite
  // direction from the team check below. Admins pass as a preview.
  const launch = await getLaunchAccess(login);
  if (!launch.allowed) return { error: "not-launched" };

  // Fails OPEN — same doctrine as the manual-freeze read, and the opposite
  // direction from the launch lock above: a team-store error must not drop a solve a
  // contestant is entitled to make, so a rejection here is read the same as
  // "has a team" rather than refused. `hasTeam` already swallows its own
  // errors and returns `true` (team-store.ts), so this only guards a caller
  // that manages to reject anyway (e.g. a test double, or a future change to
  // that contract) from breaking an entitled submit.
  let teamed: boolean;
  try {
    teamed = await hasTeam(login);
  } catch {
    teamed = true;
  }
  if (!teamed) return { error: "no-team" };

  if (typeof challengeId !== "string" || !AI_ID_RE.test(challengeId)) return { error: "invalid" };
  if (typeof flag !== "string" || !flag.trim() || flag.length > FLAG_MAX_LEN) return { error: "invalid" };

  const result = await submitAiFlag(login, challengeId, flag, { dryRun: launch.preview });
  // Activity log (issue #212): fresh solves only — an idempotent
  // re-submission banked nothing and would double-count the event. The id
  // and the path, never the flag; logActivity is fail-open, so it cannot
  // fail an award that already landed. Mirrors api/ai/submit's guard —
  // this action is the third award surface and was the only one not logging.
  // Never for a dry run (#464 admin preview): nothing was solved.
  if (result.ok && result.correct && !result.already && !result.dryRun) {
    await logActivity("ai-solve", login, `${challengeId} via flag`);
  }
  return toResponse(result);
}
