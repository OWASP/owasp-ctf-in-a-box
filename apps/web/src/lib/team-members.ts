// The ONE place a grading path resolves "the current team".
//
// A team's score is the UNION of its members' rows, so the throttles that
// guard it have to count the same team: quiz's per-question attempt cap
// (#494) and classic's per-challenge cooldown are enforced against every
// current teammate, not against whichever login happened to submit. Both
// graders therefore need the roster — resolved once, deduped, in the same
// order — and this is where that rule lives so the two cannot drift apart.
//
// A viewer with no team is a team of one, and `getViewerTeam` already reads
// an unreadable membership as "no team" (logged, never thrown), so this
// always returns at least the viewer's own login.

import "server-only";
import { getViewerTeam } from "@/lib/team-store";

/** Every CURRENT teammate's login: the viewer's own spelling first, then the
 *  roster, deduped on the EXACT string rather than the lowercased one — a
 *  per-login hash is keyed on whatever spelling wrote it, so a member stored
 *  in a different case keeps its own row alongside (an extra key costs one
 *  read; dropping the one holding that member's attempts or solves would
 *  quietly un-count them). */
export async function teamLogins(login: string): Promise<string[]> {
  const team = await getViewerTeam(login);
  return [...new Set([login, ...(team?.members ?? [])])];
}
