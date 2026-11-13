import "server-only";
import { assertPipelineOk, parseScanPage, upstashEval, upstashPipeline } from "@/lib/upstash";
import { ADMIN_AUDIT_KEY, AUDIT_CAP } from "@/lib/admin-store";
import type { AuditActor } from "@/lib/admin-audit-keys";
import { PLAYER_ID_RE, displayNameOf, getPlayerProfiles } from "@/lib/player";
import { rateLimitKeysFor } from "@/lib/rate-limit-store";
import { beginScoreLowering, endScoreLowering } from "@/lib/leaderboard/fold-cache";
import { sumAttempts } from "@/lib/attempt-row";
import { logActivity } from "@/lib/activity-log";
import { errorLabel } from "@/lib/error-label";
import { resolveTeamMaxMembers } from "@/lib/team-store";
import {
  HINTS_SPENT_KEY,
  joinCodeKey,
  membersKey,
  teamKey,
  userHintTimesKey,
  userHintsKey,
  userKey,
} from "@/lib/team-keys";
import {
  QUIZ_ANSWERED_KEY,
  QUIZ_LAST_AT_KEY,
  QUIZ_POINTS_KEY,
  quizAnswersKey,
  quizAttemptsKey,
} from "@/lib/quiz-keys";
import {
  CLASSIC_SOLVECOUNT_KEY,
  CLASSIC_LAST_AT_KEY,
  CLASSIC_SOLVED_KEY,
  CLASSIC_POINTS_KEY,
  classicAttemptsKey,
  classicOpenedKey,
  classicSolvesKey,
} from "@/lib/classic-keys";
import {
  AI_POINTS_KEY,
  AI_SOLVECOUNT_KEY,
  AI_LAST_AT_KEY,
  AI_SOLVED_KEY,
  aiAttemptsKey,
  aiOpenedKey,
  aiSolvesKey,
} from "@/lib/ai-keys";

/**
 * Per-contestant and per-team support operations for a LIVE event.
 *
 * The master reset wipes the whole event, so without these operations the
 * answer to "one person is wedged, mid-event" would be either *do nothing*
 * or *wipe everyone*. Everything here is the missing middle: act on one
 * contestant, or one team, without touching anybody else.
 *
 * Every function takes `actor` and writes an audit line naming BOTH the actor
 * (their player id and name) and the target (a player id, or a team slug). Support actions are precisely the ones that have to be
 * explicable afterwards — "who deleted that team, and when" is a question that
 * gets asked after an event, not during it.
 *
 * Callers gate on `requireAdmin`. Nothing here re-checks authorization: these
 * are the privileged primitives, and giving them a second, weaker opinion
 * about who may call them is how the two checks drift apart.
 */

export class OpsValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "OpsValidationError";
    this.field = field;
  }
}

/** Team slugs are produced by `slugify` in team-store: lowercase alphanumerics
 *  and single hyphens, 40 chars max. Validated here because these keys are
 *  built by interpolation, and an unvalidated slug is how a `*` reaches a
 *  pattern or a `:` invents a key namespace. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;

/** A player id as the stores key it: matched exactly, never lowercased or
 *  trimmed, because a near-miss names a different (or no) player. A GitHub
 *  login is refused here. */
export function requirePlayerId(value: unknown): string {
  if (typeof value !== "string" || !PLAYER_ID_RE.test(value)) {
    throw new OpsValidationError("id", "invalid player id");
  }
  return value;
}

function requireSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!SLUG_RE.test(normalized)) {
    throw new OpsValidationError("slug", `'${slug}' is not a team slug`);
  }
  return normalized;
}

/** Best-effort: every caller has already committed its write, so a failed
 *  audit line is logged and the operation still reports what it did. A 503
 *  there would send the organizer to retry something that already happened. */
async function audit(action: string, actor: AuditActor, detail: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), by: actor.id, name: actor.name, action, ...detail });
  try {
    assertPipelineOk(
      await upstashPipeline([
        ["LPUSH", ADMIN_AUDIT_KEY, line],
        ["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1],
      ]),
      `audit ${action}`,
    );
  } catch (err) {
    console.error(`[admin-ops] audit write failed for ${action}`, errorLabel(err));
  }
}

// --- read -------------------------------------------------------------------

export type UserDetail = {
  id: string;
  /** Display name from the account store, or the short-id fallback when the
   *  player has no account row. */
  name: string;
  /** null when this player is on no team. `joinedAt` is when they joined THIS
   *  team, and is null for a record written before the field existed. */
  team: { slug: string; name: string; captain: string | null; isCaptain: boolean; joinedAt: string | null } | null;
  /** First time this player was ever on a team — the funnel's conversion moment.
   *  Survives leaving, being removed, and their team being
   *  disbanded; null for a contestant who converted before the field existed. */
  firstTeamAt: string | null;
  quiz: { answered: number; points: number; attempts: number };
  classic: { solved: number; points: number; attempts: number };
  /** Same shape as classic — the two modules' per-player stores are identical
   *  (see the reset below). Without it the card shows no AI figures for a
   *  contestant whose AI solves the reset cleared. */
  ai: { solved: number; points: number; attempts: number };
  /** Secure Development solves, counted from `ctf:solves:<target>`. */
  secureDev: { solves: number };
  hints: { bought: number; spent: number };
  /** True when no key anywhere mentions this player — a signed-in player
   *  with nothing yet, worth saying so plainly instead of rendering a page of
   *  zeroes. */
  known: boolean;
};

function hashLen(result: unknown): number {
  // Upstash returns a hash as a flat [field, value, field, value, ...] array.
  return Array.isArray(result) ? Math.floor(result.length / 2) : 0;
}

/** SCAN every `ctf:solves:<target>` hash and count fields belonging to
 *  `player`. Fields are `<playerId>:<challengeId>`; a player id holds no `:`
 *  (PLAYER_ID_RE), so the `"<playerId>:"` prefix match is exact. */
async function countSecureDevSolves(player: string): Promise<number> {
  let cursor = "0";
  let total = 0;
  const prefix = `${player}:`;
  do {
    const [scan] = await upstashPipeline([
      ["SCAN", cursor, "MATCH", "ctf:solves:*", "COUNT", 1000],
    ]);
    // Throws rather than ending the walk on a failed page. This
    // count is shown to an organizer deciding whether to wipe a contestant's
    // progress, so a truncated walk understates what is about to be deleted.
    const [next, keys] = parseScanPage(scan, "count secure-dev solves");
    cursor = next;
    if (keys.length) {
      // The HKEYS replies BECOME the count, so a failed one silently
      // understates what the organizer is about to delete.
      const replies = assertPipelineOk(
        await upstashPipeline(keys.map((k) => ["HKEYS", k])),
        "count secure-dev solves",
      );
      for (const reply of replies) {
        const fields = Array.isArray(reply.result) ? (reply.result as string[]) : [];
        total += fields.filter((f) => f.startsWith(prefix)).length;
      }
    }
  } while (cursor !== "0");
  return total;
}

/**
 * Everything the organizer needs to see about one contestant before deciding
 * what to do to them. Read-only, and the first thing a support flow needs.
 */
export async function lookupUser(rawId: unknown): Promise<UserDetail> {
  const player = requirePlayerId(rawId);

  // The ai reads are appended AFTER hints rather than beside classic's, so
  // every reply position the existing callers and fixtures rely on is
  // unchanged; a short reply reads as "no ai data", never as a shifted count.
  // A per-command error throws instead: read past, it is a zero on the card.
  const [
    teamRes,
    quizAnswers,
    quizAttempts,
    quizPoints,
    quizAnswered,
    classicSolves,
    classicAttempts,
    classicPoints,
    classicSolved,
    hintsBought,
    hintsSpent,
    aiSolves,
    aiAttempts,
    aiPoints,
    aiSolved,
  ] = assertPipelineOk(
    await upstashPipeline([
      ["HMGET", userKey(player), "team", "joinedAt", "firstTeamAt"],
      ["HGETALL", quizAnswersKey(player)],
      ["HGETALL", quizAttemptsKey(player)],
      ["HGET", QUIZ_POINTS_KEY, player],
      ["HGET", QUIZ_ANSWERED_KEY, player],
      ["HGETALL", classicSolvesKey(player)],
      ["HGETALL", classicAttemptsKey(player)],
      ["HGET", CLASSIC_POINTS_KEY, player],
      ["HGET", CLASSIC_SOLVED_KEY, player],
      ["SCARD", userHintsKey(player)],
      ["HGET", HINTS_SPENT_KEY, player],
      ["HGETALL", aiSolvesKey(player)],
      ["HGETALL", aiAttemptsKey(player)],
      ["HGET", AI_POINTS_KEY, player],
      ["HGET", AI_SOLVED_KEY, player],
    ]),
    "lookup user",
  );

  const [rawSlug, rawJoinedAt, rawFirstTeamAt] = Array.isArray(teamRes.result)
    ? (teamRes.result as (string | null)[])
    : [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const slug = str(rawSlug);
  const firstTeamAt = str(rawFirstTeamAt);
  let team: UserDetail["team"] = null;
  if (slug) {
    const [nameRes, captainRes] = assertPipelineOk(
      await upstashPipeline([
        ["HGET", teamKey(slug), "name"],
        ["HGET", teamKey(slug), "captain"],
      ]),
      "lookup user team",
    );
    const captain = typeof captainRes.result === "string" ? captainRes.result : null;
    team = {
      slug,
      name: typeof nameRes.result === "string" && nameRes.result ? nameRes.result : slug,
      captain,
      isCaptain: captain === player,
      joinedAt: str(rawJoinedAt),
    };
  }

  const secureDevSolves = await countSecureDevSolves(player);
  const profile = (await getPlayerProfiles([player])).get(player);
  const quizAnsweredCount = hashLen(quizAnswers.result);
  const classicSolvedCount = hashLen(classicSolves.result);
  const aiSolvedCount = hashLen(aiSolves?.result);
  const hintsBoughtCount = Number(hintsBought.result) || 0;
  const quizAttemptCount = sumAttempts(quizAttempts.result);
  const classicAttemptCount = sumAttempts(classicAttempts.result);
  const aiAttemptCount = sumAttempts(aiAttempts?.result);

  return {
    id: player,
    name: profile?.name ?? displayNameOf({ id: player }),
    team,
    firstTeamAt,
    quiz: {
      answered: Number(quizAnswered.result) || quizAnsweredCount,
      points: Number(quizPoints.result) || 0,
      attempts: quizAttemptCount,
    },
    classic: {
      solved: Number(classicSolved.result) || classicSolvedCount,
      points: Number(classicPoints.result) || 0,
      attempts: classicAttemptCount,
    },
    ai: {
      solved: Number(aiSolved?.result) || aiSolvedCount,
      points: Number(aiPoints?.result) || 0,
      attempts: aiAttemptCount,
    },
    secureDev: { solves: secureDevSolves },
    hints: { bought: hintsBoughtCount, spent: Number(hintsSpent.result) || 0 },
    // "Known" means the box holds ANY record of this player — attempts
    // included, so a contestant who has tried and never solved is not
    // reported as having no data.
    known:
      slug !== null ||
      firstTeamAt !== null ||
      quizAnsweredCount > 0 ||
      classicSolvedCount > 0 ||
      aiSolvedCount > 0 ||
      quizAttemptCount > 0 ||
      classicAttemptCount > 0 ||
      aiAttemptCount > 0 ||
      secureDevSolves > 0 ||
      hintsBoughtCount > 0,
  };
}

// --- progress reset ---------------------------------------------------------

type ResetScope = {
  /** Fields removed, per area. */
  cleared: Record<string, number>;
  /** Things the operator must know that the operation itself cannot fix. */
  warnings: string[];
};

/** Deletes every `ctf:solves:<target>` field belonging to `player`, matched
 *  on the exact `"<playerId>:"` field prefix. Returns how
 *  many went. Separate from the pipeline below because it has to SCAN first. */
async function clearSecureDevSolves(player: string): Promise<number> {
  let cursor = "0";
  let removed = 0;
  const prefix = `${player}:`;
  do {
    const [scan] = await upstashPipeline([
      ["SCAN", cursor, "MATCH", "ctf:solves:*", "COUNT", 1000],
    ]);
    // Throws rather than ending the walk on a failed page. A
    // partial clear reported as a completed one is the worst of the five: the
    // organizer is told the contestant's progress is gone, and some of it is
    // still there to be scored.
    const [next, keys] = parseScanPage(scan, "clear secure-dev solves");
    cursor = next;
    for (const key of keys) {
      // Both commands are checked. A failed HKEYS reads as "this
      // contestant has nothing here" and skips the key; a failed HDEL leaves
      // the rows in place while `removed` counts them gone. Either way the
      // organizer is told a contestant's progress was cleared when some of it
      // is still there to be scored.
      const [reply] = assertPipelineOk(
        await upstashPipeline([["HKEYS", key]]),
        "clear secure-dev solves",
      );
      const fields = (Array.isArray(reply.result) ? (reply.result as string[]) : []).filter((f) =>
        f.startsWith(prefix),
      );
      if (fields.length) {
        assertPipelineOk(
          await upstashPipeline([["HDEL", key, ...fields]]),
          "clear secure-dev solves",
        );
        removed += fields.length;
      }
    }
  } while (cursor !== "0");
  return removed;
}

// KEYS: [1]=solves(player) [2]=attempts(player) [3]=points [4]=solved
//       [5]=solvecount   [6]=lastAt   ARGV: [1]=player
//
// Classic's and ai's per-player shape is IDENTICAL — a solves hash keyed by
// challenge id, an attempts hash, a points aggregate and a solved aggregate
// both keyed by player, and a solvecount aggregate keyed by challenge id — so
// one script serves both modules; only the keys passed in differ. Quiz has
// no per-challenge counter (its aggregates are QUIZ_POINTS_KEY/
// QUIZ_ANSWERED_KEY, both keyed by player) so it stays a plain pipeline below,
// not this script.
//
// The read (HKEYS) and every decrement it drives happen inside this ONE EVAL,
// so nothing can land between "read which challenges this player solved" and
// "decrement solvecount for each of them" — the exact window a separate
// read-then-delete pipeline leaves open (a solve landing in that window would
// get DELeted with no matching decrement, leaving solvecount permanently
// higher than the remaining rows). `player` arrives as ARGV, never spliced
// into the script text.
export const RESET_MODULE_SOLVES_SCRIPT = `
local ids = redis.call('HKEYS', KEYS[1])
local solvesRemoved = redis.call('DEL', KEYS[1])
local attemptsRemoved = redis.call('DEL', KEYS[2])
local pointsRemoved = redis.call('HDEL', KEYS[3], ARGV[1])
local solvedRemoved = redis.call('HDEL', KEYS[4], ARGV[1])
-- The award time goes with the totals it orders (#522): a reset contestant
-- keeping an old time would be ranked by a solve that no longer counts.
redis.call('HDEL', KEYS[6], ARGV[1])
for i = 1, #ids do
  redis.call('HINCRBY', KEYS[5], ids[i], -1)
end
return {solvesRemoved, attemptsRemoved, pointsRemoved, solvedRemoved, #ids}`;

type ModuleResetKeys = { solves: string; attempts: string; points: string; solved: string; solvecount: string; lastAt: string };
type ModuleResetResult = {
  solvesRemoved: number;
  attemptsRemoved: number;
  aggregatesRemoved: number;
  solveCountsDecremented: number;
};

/** Runs `RESET_MODULE_SOLVES_SCRIPT` for one player against one module's keys.
 *  Its own read decides its own decrements — nobody passes solved ids in as
 *  an argument, because an id supplied by the caller could be stale by the
 *  time the script runs. */
async function resetModuleSolves(player: string, keys: ModuleResetKeys): Promise<ModuleResetResult> {
  const result = await upstashEval(
    RESET_MODULE_SOLVES_SCRIPT,
    [keys.solves, keys.attempts, keys.points, keys.solved, keys.solvecount, keys.lastAt],
    [player],
  );
  const [solvesRemoved, attemptsRemoved, pointsRemoved, solvedRemoved, decremented] = Array.isArray(result)
    ? (result as number[])
    : [0, 0, 0, 0, 0];
  return {
    solvesRemoved: Number(solvesRemoved) || 0,
    attemptsRemoved: Number(attemptsRemoved) || 0,
    aggregatesRemoved: (Number(pointsRemoved) || 0) + (Number(solvedRemoved) || 0),
    solveCountsDecremented: Number(decremented) || 0,
  };
}

/**
 * Clears one contestant's progress, leaving the account and team membership
 * alone. The "they got into a state nobody can reproduce, put them back to
 * zero" lever.
 *
 * ABOUT SECURE DEVELOPMENT. Its solves ARE deleted here, because a reset that
 * silently skipped a third of someone's score would be worse than one that
 * warns. But they can come back: `scorer/src/store.js` writes them with
 * HSETNX specifically so replays no-op, and the sync poller re-submits from
 * the PR comments it reads. So the next time that contestant's PR is scored —
 * a push, or a re-run of the workflow — the same solves are written again.
 *
 * `resetEvent` has the same problem and solves it globally by freezing scoring
 * and bumping the `resetAt` epoch, which makes sync drop its cursor. There is
 * no per-player equivalent, so this returns a WARNING instead of pretending.
 * The organizer's move is to close the contestant's PR, or freeze scoring
 * first. Quiz, classic, and ai have no such issue: those writes originate in
 * the app (an ai solve lands the moment `/api/ai/submit` or `/api/ai/event`
 * handles the request, with no external re-ingestion path the way
 * Secure Development's scorer/sync pair has), so a delete is final.
 */
export async function resetUserProgress(rawId: unknown, actor: AuditActor): Promise<ResetScope> {
  const player = requirePlayerId(rawId);
  // Score-lowering bracket (#553, fold-cache.ts): BEFORE the first write,
  // raise the shared in-progress marker and bump the revision — a hint
  // charge on any app task is refused until this ends, however long it
  // takes, and a fold that read the old points finds its revision moved. It
  // THROWS if the marker cannot be set, and nothing is written in that
  // state. AFTER the last write — or after a stage threw with the earlier
  // ones standing — the finally closes it.
  await beginScoreLowering();
  try {
    return await resetProgressOf(player, actor);
  } finally {
    await endScoreLowering();
  }
}

/** The reset itself; `resetUserProgress` wraps it with the memo drop. */
async function resetProgressOf(player: string, actor: AuditActor): Promise<ResetScope> {
  const secureDev = await clearSecureDevSolves(player);

  // MIND WHAT EACH AGGREGATE IS KEYED BY — they are not alike, and treating
  // them alike is a silent corruption.
  //
  //   ctf:quiz:points      HINCRBY <player>      per PLAYER
  //   ctf:quiz:answered    HINCRBY <player>      per PLAYER
  //   ctf:classic:points   HINCRBY <player>      per PLAYER
  //   ctf:classic:solved   HINCRBY <player>      per PLAYER
  //   ctf:classic:solvecount HINCRBY <challengeId>  per CHALLENGE  <-- !
  //   ctf:ai:points        HINCRBY <player>      per PLAYER
  //   ctf:ai:solved        HINCRBY <player>      per PLAYER
  //   ctf:ai:solvecount    HINCRBY <challengeId>  per CHALLENGE  <-- !
  //
  // `solvecount` answers "how many people solved challenge X", so there is no
  // field for this player to delete, for EITHER module. HDELing it by player
  // would remove nothing and leave every challenge still counting a
  // contestant whose solves are gone — the per-challenge stats would drift
  // up, permanently, once per reset. It has to be DECREMENTED, once per
  // challenge this player had solved — and the read of "which challenges" and
  // every decrement it drives happen inside `RESET_MODULE_SOLVES_SCRIPT`, one
  // atomic EVAL per module, so a solve landing between "read" and "decrement"
  // is impossible: there is no gap for it to land in.
  //
  // NOT touched here: `ctf:ai:launchkey` (module-wide identity, not per-user
  // state), any `ctf:ai:nonce:*` replay guard, and the challenge catalogue —
  // a per-user reset is per-user. An outstanding launch token this contestant
  // already holds stays valid; if they redeem it after this reset, that is a
  // fresh legitimate solve, the same as a contestant replaying a quiz
  // question after their answer was cleared.
  const classicReset = await resetModuleSolves(player, {
    solves: classicSolvesKey(player),
    attempts: classicAttemptsKey(player),
    points: CLASSIC_POINTS_KEY,
    solved: CLASSIC_SOLVED_KEY,
    solvecount: CLASSIC_SOLVECOUNT_KEY,
    lastAt: CLASSIC_LAST_AT_KEY,
  });
  const aiReset = await resetModuleSolves(player, {
    solves: aiSolvesKey(player),
    attempts: aiAttemptsKey(player),
    points: AI_POINTS_KEY,
    solved: AI_SOLVED_KEY,
    solvecount: AI_SOLVECOUNT_KEY,
    lastAt: AI_LAST_AT_KEY,
  });

  // Checked before anything is counted or audited: a failed DEL/HDEL left
  // that progress in place, so the reset must not report it cleared.
  const replies = assertPipelineOk(
    await upstashPipeline([
      ["DEL", quizAnswersKey(player)],
      ["DEL", quizAttemptsKey(player)],
      ["HDEL", QUIZ_POINTS_KEY, player],
      ["HDEL", QUIZ_ANSWERED_KEY, player],
      ["DEL", userHintsKey(player)],
      ["DEL", userHintTimesKey(player)],
      ["HDEL", HINTS_SPENT_KEY, player],
      // Last, so the counts below keep their positions.
      ["HDEL", QUIZ_LAST_AT_KEY, player],
      // When this player first opened each challenge: it only times
      // their solves, so it goes with them. After the counted replies.
      ["DEL", classicOpenedKey(player)],
      ["DEL", aiOpenedKey(player)],
    ]),
    "reset progress",
  );
  const n = (i: number) => Number(replies[i]?.result) || 0;

  const cleared = {
    quizAnswers: n(0),
    quizAttempts: n(1),
    quizAggregates: n(2) + n(3),
    classicSolves: classicReset.solvesRemoved,
    classicAttempts: classicReset.attemptsRemoved,
    classicAggregates: classicReset.aggregatesRemoved,
    classicSolveCountsDecremented: classicReset.solveCountsDecremented,
    hints: n(4) + n(5) + n(6),
    aiSolves: aiReset.solvesRemoved,
    aiAttempts: aiReset.attemptsRemoved,
    aiAggregates: aiReset.aggregatesRemoved,
    aiSolveCountsDecremented: aiReset.solveCountsDecremented,
    secureDevSolves: secureDev,
  };

  const warnings: string[] = [];
  if (secureDev > 0) {
    warnings.push(
      "Secure Development solves are re-ingested from PR comments: the scorer writes them with HSETNX and the poller re-submits, so these return if this contestant's PR is scored again. Close the PR or freeze scoring to make it stick.",
    );
  }

  await audit("ops:user-reset", actor, { player, cleared });
  return { cleared, warnings };
}

// --- delete -----------------------------------------------------------------

/**
 * Removes a contestant's event state entirely: their progress, their hints,
 * their team membership, their `ctf:user:<id>` record and their rate-limit
 * counters. For a "delete my data" request as much as for support.
 *
 * The account itself (`ctf:auth:*`) and its GitHub link (`ctf:link:*`) are
 * NOT touched: they belong to the account store, and this clears what the
 * event holds about a player, not who they are.
 *
 * A captain is a deliberate refusal here — see `forceTransferCaptain`.
 */
export async function deleteUser(
  rawId: unknown,
  actor: AuditActor,
): Promise<{ cleared: Record<string, number>; warnings: string[]; leftTeam: string | null }> {
  const player = requirePlayerId(rawId);

  const detail = await lookupUser(player);
  if (detail.team?.isCaptain) {
    throw new OpsValidationError(
      "id",
      `${detail.name} is captain of "${detail.team.name}". Transfer the captaincy or disband the team first.`,
    );
  }

  // One score-lowering bracket around the WHOLE delete: the inner
  // reset nests its own — the marker is a counter — so the in-progress flag
  // stays up through the tail writes (membership, account record), and the
  // last close comes after the last write, on the failure path too.
  await beginScoreLowering();
  try {
    const reset = await resetUserProgress(player, actor);

    const leftTeam = detail.team?.slug ?? null;
    const cmds: (string | number)[][] = [];
    if (leftTeam) cmds.push(["SREM", membersKey(leftTeam), player]);
    cmds.push(["DEL", userKey(player)]);
    for (const key of rateLimitKeysFor(player)) cmds.push(["DEL", key]);
    // Checked: a refused DEL reported as a delete leaves the player on the
    // team with their record in place.
    assertPipelineOk(await upstashPipeline(cmds), "delete user");

    await audit("ops:user-delete", actor, { player, leftTeam });
    return { cleared: reset.cleared, warnings: reset.warnings, leftTeam };
  } finally {
    await endScoreLowering();
  }
}

// --- team operations --------------------------------------------------------

// Captain-guarded actions in team-store check `HGET captain == caller` INSIDE
// the script. The admin overrides deliberately do NOT take a caller into the
// guard — an organizer is allowed to act on a team they are not on. What the
// scripts still do is check the team EXISTS and that the target is a member,
// in the same atomic step as the write, so an admin override cannot be the one
// path that races with a contestant clicking Leave.

// KEYS: [1]=team [2]=members [3]=user  ARGV: [1]=player id [2]=slug
// Exported for the live suite only.
export const FORCE_REMOVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'no-team' end
if redis.call('HGET', KEYS[1], 'captain') == ARGV[1] then return 'is-captain' end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return 'not-member' end
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('HGET', KEYS[3], 'team') == ARGV[2] then redis.call('HDEL', KEYS[3], 'team', 'joinedAt') end
return 'ok'`;

/** Removes a member from a team without needing the captain to do it — the
 *  captain-only path is blocked exactly when the captain is unreachable, which
 *  is when support is needed. Refuses the captain: removing them would leave a
 *  team nobody can administer. */
export async function forceRemoveFromTeam(
  rawSlug: string,
  rawId: unknown,
  actor: AuditActor,
): Promise<{ ok: true } | never> {
  const slug = requireSlug(rawSlug);
  const player = requirePlayerId(rawId);
  const verdict = await upstashEval(
    FORCE_REMOVE_SCRIPT,
    [teamKey(slug), membersKey(slug), userKey(player)],
    [player, slug],
  );
  if (verdict === "no-team") throw new OpsValidationError("slug", `No team "${slug}"`);
  if (verdict === "is-captain") {
    throw new OpsValidationError("id", `That player is the captain — transfer the captaincy first`);
  }
  if (verdict === "not-member") {
    throw new OpsValidationError("id", `That player is not on "${slug}"`);
  }
  await audit("ops:team-remove-member", actor, { slug, player });
  return { ok: true };
}

// KEYS: [1]=team [2]=members  ARGV: [1]=newCaptain
// Exported for the live suite only.
export const FORCE_TRANSFER_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'no-team' end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return 'not-member' end
redis.call('HSET', KEYS[1], 'captain', ARGV[1])
return 'ok'`;

/**
 * Hands a team to a new captain without the old one's consent.
 *
 * The most likely live-event ticket, because a captainless team is stuck
 * completely: it cannot rename, remove a member, regenerate its code, or
 * disband — every one of those paths is captain-only. The new captain must
 * already be a member, so this cannot conjure a team for an outsider.
 */
export async function forceTransferCaptain(
  rawSlug: string,
  rawId: unknown,
  actor: AuditActor,
): Promise<{ ok: true } | never> {
  const slug = requireSlug(rawSlug);
  const player = requirePlayerId(rawId);
  const verdict = await upstashEval(
    FORCE_TRANSFER_SCRIPT,
    [teamKey(slug), membersKey(slug)],
    [player],
  );
  if (verdict === "no-team") throw new OpsValidationError("slug", `No team "${slug}"`);
  if (verdict === "not-member") {
    throw new OpsValidationError("id", `That player is not on "${slug}" — add them first`);
  }
  await audit("ops:team-transfer-captain", actor, { slug, player });
  return { ok: true };
}

// KEYS: [1]=team [2]=members [3]=user
// ARGV: [1]=player id [2]=slug [3]=cap, "" for none [4]=now (ISO)
// Puts a player on a team, moving them off their current one if they have
// one: the organizer's way back for a player who left after registration
// closed, or a move between teams. The same checks a join makes, in
// the same atomic step as the write: the team exists, the cap (unless the
// organizer overrode it), and a captain of a team with other members must
// hand it over first, as Leave requires. Leaving the old team deletes it,
// and its join code, when it empties, as LEAVE_SCRIPT does. `joinedAt` is
// the move's time, so earlier solves do not open the new team's story steps
// (ADR 60). Answers {verdict, previous team or ""}.
// Exported for the live suite only.
export const FORCE_ADD_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'no-team', ''} end
local cur = redis.call('HGET', KEYS[3], 'team')
local listed = redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
if cur == ARGV[2] and listed then return {'already-member', cur} end
if not listed and ARGV[3] ~= '' and redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[3]) then return {'full', ''} end
local from = ''
if cur and cur ~= '' and cur ~= ARGV[2] then
  local oldTeam = 'ctf:team:' .. cur
  local oldMembers = oldTeam .. ':members'
  if redis.call('HGET', oldTeam, 'captain') == ARGV[1] and redis.call('SCARD', oldMembers) > 1 then
    return {'is-captain', cur}
  end
  redis.call('SREM', oldMembers, ARGV[1])
  if redis.call('SCARD', oldMembers) == 0 then
    local code = redis.call('HGET', oldTeam, 'joinCode')
    redis.call('DEL', oldTeam, oldMembers)
    if code then redis.call('DEL', 'ctf:joincode:' .. code) end
  end
  from = cur
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], 'team', ARGV[2], 'joinedAt', ARGV[4])
redis.call('HSETNX', KEYS[3], 'firstTeamAt', ARGV[4])
return {'ok', from}`;

/**
 * Puts a player on a team, or moves them to it, whatever the registration
 * state. Enforces the team-size cap unless `overrideCap` is set.
 * Audited, and written to the activity log as a team join.
 */
export async function forceAddToTeam(
  rawSlug: string,
  rawId: unknown,
  actor: AuditActor,
  opts: { overrideCap?: boolean } = {},
): Promise<{ ok: true; id: string; name: string; from: string | null }> {
  const slug = requireSlug(rawSlug);
  const player = requirePlayerId(rawId);
  // An id with no account row would put a record on the team that no session
  // ever reads, so it is refused before anything is written.
  const profile = (await getPlayerProfiles([player])).get(player);
  if (!profile) throw new OpsValidationError("id", "No player with that id, so there is nobody to add");
  const cap = opts.overrideCap ? null : await resolveTeamMaxMembers();
  const verdict = await upstashEval(
    FORCE_ADD_SCRIPT,
    [teamKey(slug), membersKey(slug), userKey(player)],
    [player, slug, cap === null ? "" : String(cap), new Date().toISOString()],
  );
  const [status, other] = Array.isArray(verdict) ? (verdict as unknown[]).map(String) : [String(verdict), ""];
  const name = profile.name;
  if (status === "no-team") throw new OpsValidationError("slug", `No team "${slug}"`);
  if (status === "already-member") throw new OpsValidationError("id", `${name} is already on "${slug}"`);
  if (status === "full") {
    throw new OpsValidationError("slug", `"${slug}" is full (${cap} players). Tick override to add them anyway`);
  }
  if (status === "is-captain") {
    throw new OpsValidationError("id", `${name} captains "${other}", which has other members. Transfer that captaincy first`);
  }
  if (status !== "ok") throw new Error(`unexpected verdict from the add script: ${status}`);
  const from = other || null;
  await audit("ops:team-add-member", actor, { slug, player, from, overrideCap: opts.overrideCap === true });
  await logActivity("team-join", { id: player, name }, slug);
  return { ok: true, id: player, name, from };
}

/**
 * Disbands a team: clears every member's `team` pointer, drops the member set,
 * the team hash and its join code.
 *
 * Progress is NOT touched — solves and answers are per player, so a disbanded
 * team's players keep everything they earned and can regroup. Deleting their
 * work because their team was wrong would turn an admin convenience into a
 * scoring incident.
 */
export async function forceDisbandTeam(
  rawSlug: string,
  actor: AuditActor,
): Promise<{ ok: true; members: number } | never> {
  const slug = requireSlug(rawSlug);
  const [existsRes, membersRes, codeRes] = await upstashPipeline([
    ["EXISTS", teamKey(slug)],
    ["SMEMBERS", membersKey(slug)],
    ["HGET", teamKey(slug), "joinCode"],
  ]);
  if (Number(existsRes.result) !== 1) throw new OpsValidationError("slug", `No team "${slug}"`);

  const members = Array.isArray(membersRes.result) ? (membersRes.result as string[]) : [];
  const code = typeof codeRes.result === "string" && codeRes.result ? codeRes.result : null;

  // `joinedAt` describes the CURRENT membership, so it goes with it.
  // `firstTeamAt` deliberately survives — it records that this contestant
  // once converted, which stays true after their team is disbanded.
  const cmds: (string | number)[][] = members.map((m) => ["HDEL", userKey(m), "team", "joinedAt"]);
  cmds.push(["DEL", membersKey(slug)]);
  cmds.push(["DEL", teamKey(slug)]);
  // The reverse index must go too, or the code keeps resolving to a team that
  // does not exist and `/join/<code>` shows a card for a ghost.
  if (code) cmds.push(["DEL", joinCodeKey(code.toLowerCase())]);
  await upstashPipeline(cmds);

  await audit("ops:team-disband", actor, { slug, members: members.length });
  return { ok: true, members: members.length };
}
