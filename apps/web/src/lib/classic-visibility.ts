// The one answer to "may this viewer see classic challenge X?" (#186). The
// challenge page, its metadata and the attachment download route all ask it,
// so a lock added here — #464's launch, #463's story step, the module switch —
// reaches every one of them. A download route that re-derived this would let a
// guessable URL skip whichever lock it forgot.
//
// Order mirrors the page: module → launch → team → exists (and is visible)
// → story lock. Reads
// that fail THROW: the caller answers "not visible" (a page errors, a download
// 404s) rather than serve what it cannot prove is open.

import "server-only";
import { isAdminLogin } from "@/lib/admin-auth";
import { listChallenges, listStories } from "@/lib/classic-store";
import { challengeStatus, isChallengeVisible, visibleChallenges, type ChallengeStatus } from "@/lib/classic-release";
import { getTeamClassicSolvedIds } from "@/lib/classic-team";
import { isModuleLive } from "@/lib/enabled-modules";
import { getLaunchAccess } from "@/lib/launch";
import { isLocked, storyPositions } from "@/lib/story-lock";
import { hasTeam } from "@/lib/team-store";

type ClassicVisibilityState = "visible" | "module-off" | "not-launched" | "teamless" | "missing" | "locked";

type ClassicVisibility = {
  state: ClassicVisibilityState;
  /** An admin through only because the event is not launched (#464). */
  preview: boolean;
  /** Present only when an admin is looking at a challenge contestants
   *  cannot see: why (disabled, or scheduled and when). The page shows it as
   *  a banner, and grading for the admin is a dry run. */
  hidden?: Exclude<ChallengeStatus, { kind: "live" }>;
};

export async function classicVisibility(login: string | undefined, id: string): Promise<ClassicVisibility> {
  if (!(await isModuleLive("classic"))) return { state: "module-off", preview: false };
  const access = await getLaunchAccess(login);
  if (!access.allowed) return { state: "not-launched", preview: false };
  const { preview } = access;
  // A signed-in contestant with no team is sent to form one before any board
  // content; an admin is only told. Signed-out visitors read the board.
  const admin = Boolean(login) && (await isAdminLogin(login));
  if (login && !admin && !(await hasTeam(login))) return { state: "teamless", preview };
  const all = await listChallenges();
  const nowMs = Date.now();
  // A hidden challenge is `missing`, the answer an unknown id gets: on the
  // contestant side it does not exist. An admin (in preview or after launch)
  // sees every challenge, and is told when contestants cannot.
  const known = preview || admin ? all : visibleChallenges(all, nowMs);
  const record = known.find((c) => c.id === id);
  if (!record) return { state: "missing", preview };
  const status = challengeStatus(record, nowMs);
  const hidden = status.kind === "live" ? undefined : status;
  // A hidden challenge has no place in a contestant's story chain, so no
  // story lock applies to the admin looking at it.
  if (hidden) return { state: "visible", preview, hidden };
  // An admin preview opens every story step, so an organizer can check them.
  // The chain is over the visible challenges, so a hidden step is skipped
  // like a deleted one.
  if (!preview) {
    const visibleIds = new Set(all.filter((c) => isChallengeVisible(c, nowMs)).map((c) => c.id));
    const pos = storyPositions(await listStories(), visibleIds).get(id);
    if (pos?.prereq && isLocked(pos, login ? await getTeamClassicSolvedIds(login) : new Set())) {
      return { state: "locked", preview };
    }
  }
  return { state: "visible", preview };
}

/** Whether `login` is an admin and `id` is a challenge contestants cannot see
 *  right now: an admin's submission or hint reveal on it is a dry run, which
 *  records nothing for them. Any read failure answers false, which takes the
 *  normal path, where the grading and hint scripts refuse a hidden challenge
 *  themselves: never a write for it either way. */
export async function adminSeesHidden(login: string, id: string): Promise<boolean> {
  try {
    if (!(await isAdminLogin(login))) return false;
    const record = (await listChallenges()).find((c) => c.id === id);
    return record !== undefined && !isChallengeVisible(record, Date.now());
  } catch {
    return false;
  }
}
