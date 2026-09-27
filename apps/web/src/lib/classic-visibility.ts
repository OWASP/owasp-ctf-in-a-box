// The one answer to "may this viewer see classic challenge X?" (#186). The
// challenge page, its metadata and the attachment download route all ask it,
// so a lock added here — #464's launch, #463's story step, the module switch —
// reaches every one of them. A download route that re-derived this would let a
// guessable URL skip whichever lock it forgot.
//
// Order mirrors the page: module → launch → team → exists → story lock. Reads
// that fail THROW: the caller answers "not visible" (a page errors, a download
// 404s) rather than serve what it cannot prove is open.

import "server-only";
import { isAdminLogin } from "@/lib/admin-auth";
import { listChallenges, listStories } from "@/lib/classic-store";
import { getTeamClassicSolvedIds } from "@/lib/classic-team";
import { isModuleLive } from "@/lib/enabled-modules";
import { getLaunchAccess } from "@/lib/launch";
import { isLocked, storyPositions } from "@/lib/story-lock";
import { hasTeam } from "@/lib/team-store";

export type ClassicVisibilityState = "visible" | "module-off" | "not-launched" | "teamless" | "missing" | "locked";

export type ClassicVisibility = {
  state: ClassicVisibilityState;
  /** An admin through only because the event is not launched (#464). */
  preview: boolean;
};

export async function classicVisibility(login: string | undefined, id: string): Promise<ClassicVisibility> {
  if (!(await isModuleLive("classic"))) return { state: "module-off", preview: false };
  const access = await getLaunchAccess(login);
  if (!access.allowed) return { state: "not-launched", preview: false };
  const { preview } = access;
  // A signed-in contestant with no team is sent to form one before any board
  // content; an admin is only told. Signed-out visitors read the board.
  if (login && !(await isAdminLogin(login)) && !(await hasTeam(login))) return { state: "teamless", preview };
  const all = await listChallenges();
  if (!all.some((c) => c.id === id)) return { state: "missing", preview };
  // An admin preview opens every story step, so an organizer can check them.
  if (!preview) {
    const pos = storyPositions(await listStories(), new Set(all.map((c) => c.id))).get(id);
    if (pos?.prereq && isLocked(pos, login ? await getTeamClassicSolvedIds(login) : new Set())) {
      return { state: "locked", preview };
    }
  }
  return { state: "visible", preview };
}
