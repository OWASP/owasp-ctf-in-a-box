import "server-only";
import { redirect } from "next/navigation";
import { hasTeam } from "@/lib/team-store";
import { TEAM_SETUP_PATH } from "@/lib/post-signin";

/**
 * Page-level half of the team requirement (issue #153).
 *
 * The API routes are the boundary that actually holds — a direct POST never
 * sees a page — and they refuse a teamless player with `403 { error:
 * "no-team" }`. This exists so nobody discovers that by answering a question
 * and being told it didn't count: a signed-in contestant with no team is sent
 * to set one up before they reach a module at all.
 *
 * Deliberately its own module rather than a function in `team-store.ts`:
 * `redirect()` comes from `next/navigation` and throws a framework control-flow
 * signal, which is exactly the wrong thing to have reachable from a store that
 * API routes and the sync-facing code also import.
 */

/** Where a teamless contestant is sent — owned by lib/post-signin.ts (the
 *  pure module both this and the sign-in steering can import), re-exported
 *  here for the existing importers. */
export { TEAM_SETUP_PATH } from "@/lib/post-signin";

/**
 * Redirects a signed-in contestant with no team to team setup.
 *
 * Two exemptions, both deliberate:
 *
 * SIGNED OUT passes through. A visitor browsing the board is not yet a
 * contestant, and bouncing them to a profile page they cannot see would be
 * worse than the sign-in prompt the page already renders.
 *
 * ADMINS pass through. An organizer opens a module page to check that their
 * questions and challenges render, which is not playing, and forcing them into
 * a team to do it would be a strange toll. It is not a scoring hole: an admin
 * who actually submits still meets the route gate, because an admin's points
 * fold into no team either.
 *
 * Inherits `hasTeam`'s fail-open behaviour — a Redis blip leaves contestants
 * on the page rather than herding everyone to /profile mid-event.
 *
 * RETURNS whether the viewer is signed in with no team and was let through
 * anyway (issue #357). Only the admin exemption can produce `true`: a teamless
 * contestant is redirected, and a signed-out visitor has no team to lack.
 *
 * The exemption is right and stays. What was wrong is that it exempted
 * organizers from the INFORMATION as well as from the redirect: the page
 * rendered them a submit form, the route refused the submission with
 * `no-team`, and the first they heard of the rule was a flag that did not
 * count. The population most likely to be testing a board was the one
 * guaranteed to discover the rule by losing a submission to it. Callers hand
 * this to `<TeamlessNotice />` and say so before the form, not after.
 */
export async function redirectIfTeamless(
  playerId: string | undefined,
  options: { isAdmin?: boolean } = {},
): Promise<boolean> {
  if (!playerId) return false;
  if (await hasTeam(playerId)) return false;
  // Teamless from here down: an admin is told, anyone else is sent to fix it.
  if (options.isAdmin) return true;
  redirect(TEAM_SETUP_PATH);
}
