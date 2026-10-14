// First-blood announcements (#590). Trigger-driven, NOT ticker-driven: the
// submit routes call `notifyFirstBlood` right after a FRESH solve lands
// (fresh = `!result.already`, and never a dry run), so the announcement
// fires seconds after the solve instead of at the next 30s tick.
//
// The route hooks stay one line and NON-BLOCKING (`void notifyFirstBlood(...)`)
// — this function never throws, so an unawaited rejection cannot fail a
// solve that already banked its points.
//
// The dedup discipline here is claim-then-post, on purpose:
//   configured+switch off → no claim, nothing (enabling later does not
//     replay history; only solves from then on can be first bloods);
//   configured+switch on  → HSETNX the claim FIRST, then enqueue. Exactly
//     one caller across replicas, retries and the ticker can win the claim,
//     so a teammate double-submitting or two replicas grading concurrently
//     cannot produce two posts.
//
// Title and points are looked up HERE from the module's public list (never
// from the admin surface, never from the request body), so the solve routes
// need pass nothing but the ids — and a challenge deleted in the seconds
// between solve and lookup still announces under its id rather than being
// silently dropped.
//
// Every failure is logged (label only) and swallowed — a Discord hiccup must
// never surface on a contestant's submit response.

import "server-only";
import { errorLabel } from "@/lib/error-label";
// Resolved from listTeams + a case-insensitive membership join, NOT
// getViewerTeam: getViewerTeam reads the mock-team COOKIE in demo mode,
// which would make the ai solve routes (structurally cookie-blind, see
// api/ai/__tests__/contract.test.ts) cookie-dependent the moment this hook
// ran. The team store's own membership list is also the right source — the
// announcement describes the solving TEAM, server-side, not a browser's
// current view of it.
import { listTeams } from "@/lib/team-store";
import { resolveOrigin } from "@/lib/app-origin";
import { listChallenges } from "@/lib/classic-store";
import { visibleNow } from "@/lib/classic-release";
import { listQuestions } from "@/lib/quiz-store";
import { listAiChallenges } from "@/lib/ai-store";
import { buildFirstBloodMessage } from "./messages";
import { enqueueAnnouncement } from "./sender";
import { claimLedgerField, getAnnounceConfig } from "./store";
import { ANNOUNCE_FIRST_KEY } from "./keys";
import { releaseField } from "./detect";

export type FirstBloodInput = {
  module: "classic" | "quiz" | "ai";
  challengeId: string;
  /** The solving login — the session's, never the body's. Displayed as the
   *  TEAM name when the solver has one, else the bare login. */
  login: string;
};

/** Public title + points for one challenge, from the module's PUBLIC list
 *  (the same one the board reads — no flags, no answers ride along). Null
 *  when the challenge no longer exists or is no longer public: a hidden
 *  challenge's TITLE must never ride an announcement (the caller then falls
 *  back to the bare id, which leaks nothing). */
async function lookupItem(module: FirstBloodInput["module"], id: string): Promise<{ title: string; points: number } | null> {
  if (module === "classic") {
    const c = visibleNow(await listChallenges()).find((x) => x.id === id);
    return c ? { title: c.title, points: c.points } : null;
  }
  if (module === "quiz") {
    const q = (await listQuestions()).find((x) => x.id === id);
    return q ? { title: q.prompt, points: q.points } : null;
  }
  const c = (await listAiChallenges()).find((x) => x.id === id);
  return c ? { title: c.title, points: c.points } : null;
}

/** Announces first blood for one fresh solve, if the announcer is armed for
 *  it. Never throws; never logs the login or any challenge content beyond
 *  the public title the message itself carries. */
export async function notifyFirstBlood(input: FirstBloodInput): Promise<void> {
  try {
    const config = await getAnnounceConfig();
    // Gate BEFORE the claim: an unconfigured box (or one that does not want
    // first bloods) must not consume the claim, or turning the feature on
    // later would find every existing challenge already "claimed" by a
    // silent sweep. This gate is also what keeps the title lookup below off
    // the hot path for the default (unconfigured) box.
    if (!config.webhookConfigured || !config.firstBlood) return;

    const field = releaseField(input.module, input.challengeId);
    const claimed = await claimLedgerField(ANNOUNCE_FIRST_KEY, field);
    if (!claimed) return;

    const item = await lookupItem(input.module, input.challengeId).catch(() => null);
    // Case-insensitive join, like every other login join in this codebase:
    // the scorer records the PR author's spelling, the team store the
    // session's, and GitHub logins are unique only case-insensitively.
    const lower = input.login.toLowerCase();
    const teams = await listTeams().catch(() => []);
    const team = teams.find((t) => t.members.some((m) => m.toLowerCase() === lower));
    const who = team?.name || input.login;
    const origin = resolveOrigin();
    // Quiz has no per-question page — the board is the right link. Classic
    // and ai each have a per-challenge page.
    const url =
      input.module === "quiz" ? `${origin}/quiz` : `${origin}/${input.module === "classic" ? "flags" : "ai"}/${input.challengeId}`;

    await enqueueAnnouncement(
      "first-blood",
      buildFirstBloodMessage({
        // A challenge deleted between solve and lookup still announces —
        // under its id, with zero points — rather than vanishing.
        challengeTitle: item?.title ?? input.challengeId,
        points: item?.points ?? 0,
        who,
        url,
      }),
    );
  } catch (err) {
    console.error("[announce] first-blood notify failed:", errorLabel(err));
  }
}
