// The ONE place a grading path resolves "the current team".
//
// A team's score is the UNION of its members' rows, so the throttles that
// guard it have to count the same team: quiz's per-question attempt cap
// (#494) and classic's per-challenge cooldown are enforced against every
// current teammate, not against whichever login happened to submit. Both
// graders therefore need the roster — resolved once, deduped, in the same
// order — and this is where that rule lives so the two cannot drift apart.
//
// Two readers, deliberately:
//
//   `teamLogins`        LENIENT. A membership read that fails is read as
//                       "no team" (`getViewerTeam`'s documented behaviour,
//                       logged, never thrown). That is CLOSED for the
//                       solve/unlock reads in classic-team.ts: fewer
//                       unlocks, never more.
//   `strictTeamLogins`  STRICT, grading only (#576). "No team" here would
//                       silently hand the submitter its own private budget
//                       while a teammate holds the real one, so a failed
//                       read THROWS and the grader answers `unavailable`
//                       without grading or spending an attempt.
//
// A viewer with no team is a team of one either way: the strict reader
// returns that only when the read SUCCEEDS and finds no team.

import "server-only";
import { upstashPipeline } from "@/lib/upstash";
import { membersKey, userKey } from "@/lib/team-keys";
import { getViewerTeam } from "@/lib/team-store";

/** Every CURRENT teammate's login: the viewer's own spelling first, then the
 *  roster, deduped on the EXACT string rather than the lowercased one — a
 *  per-login hash is keyed on whatever spelling wrote it, so a member stored
 *  in a different case keeps its own row alongside (an extra key costs one
 *  read; dropping the one holding that member's attempts or solves would
 *  quietly un-count them). LENIENT: an unreadable membership is "no team". */
export async function teamLogins(login: string): Promise<string[]> {
  const team = await getViewerTeam(login);
  return [...new Set([login, ...(team?.members ?? [])])];
}

/** The same roster for the two GRADING paths (#576), read STRICTLY: the
 *  viewer first, then the roster, deduped on the EXACT string exactly as
 *  `teamLogins` dedupes it (same rule, so the two cannot disagree about who
 *  is on the team).
 *
 *  The difference is the FAILURE direction. `getViewerTeam` reads a failed
 *  membership read as "no team" and an SMEMBERS `{ error }` reply as an
 *  empty roster — both would downgrade a team's shared budget to this
 *  login's own row at exactly the moment the roster could not be trusted.
 *  So this reads the membership and the roster itself and THROWS on a
 *  transport failure or an Upstash `{ error }` reply from either read; only
 *  a read that SUCCEEDS and finds no membership answers the team of one.
 *  Each grading caller catches the throw and refuses (`unavailable`). */
export async function strictTeamLogins(login: string): Promise<string[]> {
  const [slugRes] = await upstashPipeline([["HGET", userKey(login), "team"]]);
  if (!slugRes || slugRes.error) {
    throw new Error(`Upstash HGET user team failed: ${slugRes?.error ?? "no reply"}`);
  }
  const slug = typeof slugRes.result === "string" && slugRes.result ? slugRes.result : null;
  if (!slug) return [login];

  const [membersRes] = await upstashPipeline([["SMEMBERS", membersKey(slug)]]);
  if (!membersRes || membersRes.error) {
    throw new Error(`Upstash SMEMBERS team members failed: ${membersRes?.error ?? "no reply"}`);
  }
  const members = Array.isArray(membersRes.result) ? (membersRes.result as string[]) : [];
  return [...new Set([login, ...members])];
}
