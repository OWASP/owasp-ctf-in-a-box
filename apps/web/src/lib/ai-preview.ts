// Is a `ctf.preview` launch token (#464) still honourable? Only while the
// event has NOT launched: a preview token is an organizer checking the board
// before kickoff, and its solves are graded dry. Minted an hour before launch
// and used after it, the same token would silently drop an admin's real solve
// and hand its holder a cooldown-free flag oracle for the token's 24h TTL — so
// once the event launches, the token routes refuse it and the player
// re-launches for a normal token.
//
// Deliberately NOT `@/lib/launch`: the AI token routes are cookie-blind by
// contract (no session, no `@/lib/auth`), and this needs only the scoring
// start. Fails CLOSED: if the settings cannot be read, the preview token is
// refused rather than guessed at.

import "server-only";
import { getAdminSettings } from "@/lib/admin-store";
import { isLaunched } from "@/lib/schedule-window";

export async function previewClaimStillValid(nowMs: number = Date.now()): Promise<boolean> {
  try {
    const settings = await getAdminSettings();
    return !isLaunched(nowMs, settings.scoringStartsAt);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error("ai preview: settings read failed, refusing the preview token:", e.name, e.message);
    return false;
  }
}
