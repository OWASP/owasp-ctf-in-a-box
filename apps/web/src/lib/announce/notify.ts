// First-blood announcements (#590). Trigger-driven, NOT ticker-driven: the
// submit routes call `notifyFirstBlood` right after a FRESH solve lands
// (fresh = `!result.already`, and never a dry run), so the announcement
// fires seconds after the solve instead of at the next 30s tick.
//
// The route hooks stay one line and NON-BLOCKING (`void notifyFirstBlood(...)`)
// — this function never throws, so an unawaited rejection cannot fail a
// solve that already banked its points.
//
// The dedup discipline is record-then-notify, on purpose:
//   configured+switch off → no read, nothing (enabling later does not
//     replay history; only solves from then on can be first bloods);
//   configured+switch on  → read the first-solver record the award script
//     wrote atomically with the solve, and proceed only when it names this
//     caller. The announcement claim is then checked and written in the
//     SAME Lua script that enqueues the post, so a teammate double-
//     submitting or two replicas grading concurrently cannot produce two
//     posts.
//
// The record, not a notification race, decides who may post: a later
// solver's notification can never steal the first-blood post, and a hidden
// challenge returns before any claim is spent.
//
// Title and points are looked up HERE from the module's public list (never
// from the admin surface, never from the request body), so the solve routes
// need pass nothing but the ids — and a quiz challenge deleted in the
// seconds between solve and lookup still announces under its id rather than
// being silently dropped. A CLASSIC challenge that is not on the VISIBLE
// board at lookup time (hidden, not yet released, or deleted after the
// solve) posts NOTHING: a deleted story step has no record left for
// `storyPositions` to place, so the board's lock gate below could never run
// and its bare id would publish a step the board redacts.
//
// Every failure is logged (label only) and swallowed — a Discord hiccup must
// never surface on a contestant's submit response.

import "server-only";
import { errorLabel } from "@/lib/error-label";
// Resolved from listTeams + a case-insensitive membership join, NOT
// getViewerTeam: getViewerTeam reads the mock-team COOKIE in demo mode,
// which would make the solve routes cookie-dependent the moment this hook
// ran. The team store's own membership list is also the right source — the
// announcement describes the solving TEAM, server-side, not a browser's
// current view of it.
import { getPlayerProfiles } from "@/lib/player";
import { listTeams } from "@/lib/team-store";
import { listStories, readChallengeRecords } from "@/lib/classic-store";
import { visibleNow } from "@/lib/classic-release";
import { listQuestions } from "@/lib/quiz-store";
import { isLocked, storyPositions } from "@/lib/story-lock";
import { buildFirstBloodMessage } from "./messages";
import { enqueueLedgerAnnouncement } from "./sender";
import { getAnnounceConfig, readLedgerField } from "./store";
import { ANNOUNCE_FIRST_ANNOUNCED_KEY, ANNOUNCE_FIRST_KEY } from "./keys";
import { challengeField } from "./detect";

export type FirstBloodInput = {
  module: "classic" | "quiz";
  challengeId: string;
  /** The solving player's id — the session's, never the body's. Displayed as
   *  the TEAM name when the solver has one, else the player's display name. */
  playerId: string;
  /** The points the award script banked for this solve — the message carries
   *  these, never a later catalogue price an admin may have changed. */
  points?: number;
};

/** Public prompt + points for one quiz item, from the module's public
 *  list (the same one the board reads — no flags, no answers ride along).
 *  Null when the challenge no longer exists: a missing or unverified
 *  challenge must never post, because its ID embeds the prompt slug.
 *  A read failure throws so the caller can log it. Classic goes through
 *  the secrecy gate below instead, because a story step must be judged
 *  before even its ID is safe to name. */
async function lookupItem(id: string): Promise<{ title: string; points: number } | null> {
  const q = (await listQuestions()).find((x) => x.id === id);
  return q ? { title: q.prompt, points: q.points } : null;
}

/** Resolves an absolute HTTP(S) URL for a challenge/board link from
 *  BETTER_AUTH_URL. Returns undefined when BETTER_AUTH_URL is missing,
 *  not an absolute URL, or uses a non-HTTP(S) protocol so an invalid
 *  URL is never sent in an announcement embed. */
export function challengeEmbedUrl(
  module: "classic" | "quiz",
  challengeId: string,
  authUrl?: string | null,
): string | undefined {
  const target = arguments.length > 2 ? authUrl : process.env.BETTER_AUTH_URL;
  if (!target) return undefined;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const origin = parsed.origin;
    const path = module === "quiz" ? "/quiz" : `/flags/${challengeId}`;
    return `${origin}${path}`;
  } catch {
    return undefined;
  }
}

/** Announces first blood for one fresh solve, if the announcer is armed for
 *  it. Never throws; never logs the player id or any challenge content beyond
 *  the public title the message itself carries. */
export async function notifyFirstBlood(input: FirstBloodInput): Promise<void> {
  try {
    const config = await getAnnounceConfig();
    // Gate BEFORE the claim: an unconfigured box (or one that does not want
    // first bloods) must not consume the claim, or turning the feature on
    // later would find every existing challenge already "claimed" by a
    // silent sweep. This gate is also what keeps the content lookups below
    // off the hot path for the default (unconfigured) box.
    if (!config.webhookConfigured || !config.firstBlood) return;

    // The award script names the true first solver atomically with the
    // solve. Only that player may announce, so a later solver's notification
    // can never race ahead and steal the first-blood post.
    const field = challengeField(input.module, input.challengeId);
    const recorded = await readLedgerField(ANNOUNCE_FIRST_KEY, field);
    if (!recorded) return;
    let firstSolver: { playerId?: unknown } | null = null;
    try {
      firstSolver = JSON.parse(recorded) as { playerId?: unknown } | null;
    } catch {
      return;
    }
    if (typeof firstSolver?.playerId !== "string" || firstSolver.playerId !== input.playerId) {
      return;
    }

    let item: { title: string; points: number } | null;
    if (input.module === "classic") {
      const all = await readChallengeRecords();
      const visible = visibleNow(all);
      const c = visible.find((x) => x.id === input.challengeId);
      // Not on the VISIBLE board — hidden, unreleased, or deleted between
      // the solve and this lookup. No post, and no fallback to the bare id:
      // a deleted story step leaves no record for `storyPositions` (below)
      // to place, so the lock gate could not run and the id itself is what
      // the board redacts.
      if (!c) return;
      // Secrecy gate (ADR 60): the board redacts a story step to any reader
      // whose team has not unlocked it — title, points AND id — and an
      // announcement's audience is everyone in the channel, so a step locked
      // for even one of them may appear in no part of the post. Evaluated
      // with the board's own isLocked from the no-solve view (api/board/
      // items/route.ts pairs it with the viewer's solves; the empty set is
      // the most locked view there is, and every other reader only opens
      // further): step 1 has no prereq and passes, every later step withholds
      // the whole announcement — not even the bare id, which the board also
      // redacts because ids are derived from titles. A read that throws lands
      // in the outer catch: unreadable means NO post, never a guess.
      const positions = storyPositions(await listStories(), new Set(visible.map((x) => x.id)));
      const pos = positions.get(input.challengeId);
      if (pos && isLocked(pos, new Set())) return;
      item = { title: c.title, points: c.points };
    } else {
      // FAIL CLOSED: a failed or absent quiz lookup posts nothing. The ID embeds
      // the prompt slug (generateQuestionId), so it must not be named without a
      // verified public item.
      item = await lookupItem(input.challengeId);
      if (!item) return;
    }

    // Team membership and display names are keyed by player id, never login.
    const teams = await listTeams().catch(() => []);
    const team = teams.find((t) => t.members.includes(input.playerId));
    const profiles = await getPlayerProfiles([input.playerId]).catch(() => new Map());
    const who = team?.name || profiles.get(input.playerId)?.name || input.playerId;
    const url = challengeEmbedUrl(input.module, input.challengeId);

    // Revalidate question existence after enriching with team and player data:
    // an organizer may have deleted the question while those lookups were pending.
    if (input.module === "quiz") {
      const fresh = await lookupItem(input.challengeId);
      if (!fresh) return;
      item = fresh;
    }

    await enqueueLedgerAnnouncement(
      "first-blood",
      buildFirstBloodMessage({
        challengeTitle: item.title,
        points: input.points ?? item.points,
        who,
        ...(url ? { url } : {}),
      }),
      ANNOUNCE_FIRST_ANNOUNCED_KEY,
      [field],
      // The counters read BEFORE the asynchronous lookups above: the claim
      // and enqueue happen in one script that rejects both if the stream or
      // webhook changed while the lookup ran.
      { webhookGeneration: config.webhookGeneration, kindEpoch: config.kindEpochs["first-blood"] },
    );
  } catch (err) {
    console.error("[announce] first-blood notify failed:", errorLabel(err));
  }
}
