import "server-only";
import { errorLabel } from "@/lib/error-label";
import { upstashEval, upstashPipeline } from "@/lib/upstash";

/**
 * The folded leaderboard's invalidation token (#553), in three parts.
 *
 * 1. A PROCESS-local generation. The fold is memoized for ~10 s
 *    (`folded.ts`); that is fine while scores only grow — a stale read
 *    undercounts, which every reader tolerates — but the admin operations
 *    that LOWER a folded score must not leave the board on the instance that
 *    did the write serving the old one for a TTL. `folded.ts` stamps each
 *    fold with the generation it STARTED under and serves nothing stamped
 *    older — a fold already running when the invalidation came is discarded
 *    too, since it read the old keys.
 *
 * 2. A Redis-backed SCORE REVISION (`ctf:admin:score-rev`) every app task
 *    can see. The AWS module runs two app tasks, so a process-local signal
 *    never reaches the other one — and even a fresh fold there can finish
 *    AFTER a write here lowered the score. So the hint gate's gross travels
 *    with the revision it was folded under (`hint-balance.ts` reads it
 *    BEFORE folding), and the reveal script compares it to the current one
 *    before it reads the spend or charges: moved means `stale`, and the
 *    store re-reads and retries once (`REVEAL_SCRIPT`, ARGV[9] / KEYS[5]).
 *
 * 3. An OPERATION-IN-PROGRESS counter (`ctf:admin:score-lowering`). The
 *    revision alone cannot cover the MIDDLE of a multi-step wipe: a fold
 *    that starts after the leading bump reads points that are still being
 *    deleted, under a revision that will not move again until the wipe
 *    ends. So every score-lowering operation is BRACKETED — `begin` raises
 *    the counter and bumps the revision before its first write, `end`
 *    lowers it and bumps again after its last — and while the counter is
 *    up, `currentScoreRevision` refuses (the gate answers `busy`, closed)
 *    and the script refuses (`stale`, KEYS[6]). A counter, not a flag, so
 *    two admins' operations nest; a TTL stuck-guard so a task that dies
 *    mid-operation cannot freeze hint purchases for good.
 *
 *    `begin` THROWS on failure and the caller must not write: without the
 *    marker another task still sees the old revision and no flag, and could
 *    charge a hint against a gross this operation is about to lower. `end`
 *    never throws — the operation's own outcome is what the caller reports
 *    — but logs, since the other tasks then keep refusing until the TTL.
 *
 *    Both are ONE Lua script each, because a pipeline is not atomic: an
 *    INCR that lands while the EXPIRE fails would leave a positive counter
 *    with no stuck-guard, the caller would never reach `end`, and every
 *    purchase would be refused until someone noticed. The stuck-guard is
 *    armed only when the key has no TTL yet, and `end` DELETES the key once
 *    no bracket is open: a counter left stuck by a dead task expires
 *    `SCORE_LOWERING_TTL_S` after the FIRST begin however many later
 *    operations run, and the next begin after a clean close arms a fresh
 *    guard. The accepted trade-off: a bracket that opens in the last seconds
 *    of a guard armed by an operation STILL running after ~5 minutes is
 *    guarded only until that guard expires — no wipe this kit performs takes
 *    a hundredth of that.
 *
 * The brackets: the master reset and every settings write (`admin-store.ts`
 * — the fold counts only the ENABLED modules' points, so switching one off
 * lowers scores), the demo clear (`admin-store.ts`), Support's per-player
 * reset and delete (`admin-ops-store.ts`). `end` runs in a `finally`: a
 * failure midway leaves the earlier destructive stages standing. An archive
 * import goes through the master reset first and then adds content only.
 *
 * Both keys sit under the `ctf:admin:` prefix the master reset keeps — the
 * marker must survive the very operation it guards.
 *
 * A leaf on purpose: `admin-store` sits UPSTREAM of the fold (the fold's
 * penalty stage reads the hint config, which reads admin settings), so it
 * cannot import `folded.ts` without a cycle.
 */
export const SCORE_REV_KEY = "ctf:admin:score-rev";
export const SCORE_LOWERING_KEY = "ctf:admin:score-lowering";
/** Stuck-guard on the in-progress counter: longer than any wipe the kit
 *  performs (the master reset SCANs a handful of prefixes), short enough
 *  that a task dying mid-operation does not block hint purchases for long. */
export const SCORE_LOWERING_TTL_S = 300;

/** Thrown by `currentScoreRevision` while a score-lowering operation is
 *  running. Matched by NAME, not `instanceof`: the store's tests reload
 *  modules between cases, and a class identity does not survive that. */
export class ScoreLoweringInProgress extends Error {
  constructor() {
    super("a score-lowering operation is in progress");
    this.name = "ScoreLoweringInProgress";
  }
}

let generation = 0;

/** Drop this instance's memo. Process-local only. */
export function invalidateFoldedLeaderboard(): void {
  generation++;
}

/** The current generation, for `folded.ts` to stamp and compare. */
export function foldGeneration(): number {
  return generation;
}

// KEYS: [1]=in-progress counter [2]=score revision. ARGV: [1]=stuck-guard TTL (s).
// Atomic: bump the revision, raise the counter, arm the stuck-guard only if
// none is armed (a later begin must not keep renewing a guard a dead task
// left behind). THE REVISION GOES FIRST: a script does not roll back, and
// an INCR on a key that somehow holds a non-integer throws — were the
// counter raised before that, it would stay raised (blocking every
// purchase) until the guard expired, with no `end` ever running. Ordered
// this way, a throw means nothing landed. Exported for the tests and the
// live suite.
export const BEGIN_SCORE_LOWERING_SCRIPT = `
redis.call('INCR', KEYS[2])
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

// KEYS: [1]=in-progress counter [2]=score revision.
// Atomic: bump the revision, then lower the counter and, once no bracket is
// open (or the guard already expired it below zero), DELETE the key so the
// next begin arms a fresh guard rather than inheriting a stale one. The
// revision first here too: the trailing bump is what outdates a fold that
// started mid-operation, and must land even if the counter key is junk.
export const END_SCORE_LOWERING_SCRIPT = `
redis.call('INCR', KEYS[2])
local n = redis.call('DECR', KEYS[1])
if n <= 0 then redis.call('DEL', KEYS[1]) n = 0 end
return n`;

/** Open a score-lowering bracket: raise the shared in-progress counter (with
 *  the stuck-guard TTL), bump the shared revision, drop this memo — in one
 *  atomic script. THROWS on any failure — the caller must not proceed to
 *  its first write. Atomic, so a throw means nothing landed. */
export async function beginScoreLowering(): Promise<void> {
  invalidateFoldedLeaderboard();
  await upstashEval(BEGIN_SCORE_LOWERING_SCRIPT, [SCORE_LOWERING_KEY, SCORE_REV_KEY], [SCORE_LOWERING_TTL_S]);
}

/** Close the bracket: lower the counter (deleting the key once no bracket is
 *  open), bump the revision, drop this memo — in one atomic script. Never
 *  throws — logs — so the operation's own outcome is what the caller
 *  reports. */
export async function endScoreLowering(): Promise<void> {
  invalidateFoldedLeaderboard();
  try {
    await upstashEval(END_SCORE_LOWERING_SCRIPT, [SCORE_LOWERING_KEY, SCORE_REV_KEY], []);
  } catch (err) {
    console.error(
      "fold-cache: score-lowering bracket could not be closed (other app tasks refuse hint purchases until the stuck-guard expires):",
      errorLabel(err),
    );
  }
}

/** The shared revision as the script will compare it — the stored string,
 *  "0" when nothing has ever bumped it — read together with the in-progress
 *  counter. Throws `ScoreLoweringInProgress` while an operation is running,
 *  and on a read error: a gross nobody can vouch for is refused by the gate
 *  (closed), not guessed. */
export async function currentScoreRevision(): Promise<string> {
  const [rev, lowering] = await upstashPipeline([
    ["GET", SCORE_REV_KEY],
    ["GET", SCORE_LOWERING_KEY],
  ]);
  const failed = [rev, lowering].find((r) => r.error !== undefined);
  if (failed) throw new Error(`score revision read failed: ${failed.error}`);
  if ((Number(lowering.result) || 0) > 0) throw new ScoreLoweringInProgress();
  return rev.result == null ? "0" : String(rev.result);
}
