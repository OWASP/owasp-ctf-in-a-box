import "server-only";
import { errorLabel } from "@/lib/error-label";
import { scoringEnded } from "@/lib/schedule-window";
// Re-exported, not redeclared: the admin UI is a Client Component and cannot
// import from this server-only module, so the values live in the
// dependency-free defaults file and both sides read the same constant.
export { HINT_COST, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN } from "./hint-defaults";
import { hintBalance, type HintBalance } from "@/lib/hint-balance";
import { SCORE_LOWERING_KEY, SCORE_REV_KEY } from "@/lib/leaderboard/fold-cache";
import { HINTS_AVAILABLE, resolveHintConfig } from "@/lib/hint-config";
import { appsById, type AppId } from "@/lib/apps";
import { AI_HINTS_KEY, aiSolvesKey } from "@/lib/ai-keys";
import { CLASSIC_HINTS_KEY, classicSolvesKey } from "@/lib/classic-keys";
import { isModuleLive } from "@/lib/enabled-modules";
import { HINTS_SPENT_KEY, userHintTimesKey } from "@/lib/team-keys";
import { upstashEval, upstashPipeline } from "@/lib/upstash";
import { listChallengeIds, listStories } from "@/lib/classic-store";
import { teamSolveKeys } from "@/lib/classic-team";
import { storyPositions } from "@/lib/story-lock";
// Moved to hint-config.ts (#553): the leaderboard's penalty fold imports them
// from there, because this store now imports the fold (through hint-balance)
// for the affordability gate. Re-exported so the store's callers are unchanged.
export { getHintNotice, getHintPenalties, HINTS_AVAILABLE, resolveHintConfig } from "@/lib/hint-config";

/**
 * Paid hints — for `classic` and `ai`. **Secure Development has none**, and
 * cannot: no code path in this kit writes a `hints:<app>` field. The comment
 * here used to call those hashes "scorer-owned", but the scorer has no concept
 * of a hint at all (`grep -rni hint scorer/src/` is empty), so availability for
 * secure-development targets was always empty and `/challenges` told every
 * contestant "no challenge is offering one yet" — permanently (issue #334).
 * Rather than leave the machinery pointed at a producer that does not exist,
 * secure-development is out of the availability read; if hint text ever gains
 * an author, that is the decision to revisit, not this comment.
 *
 * Purchases are recorded under the site's ctf: namespace, which
 * the scorer never rewrites, so penalties survive re-scores:
 *   SADD ctf:user:<login>:hints "<app>/<challengeId>"   (what the user bought)
 *   HINCRBY ctf:hints:spent <login> HINT_COST           (running penalty total)
 * Displayed scores subtract the penalty as an overlay (see
 * leaderboard/hint-penalties.ts) — the scorer's leaderboard ZSET is never
 * decremented.
 *
 * Callers (the /api/hints route handlers) are responsible for authenticating
 * the session and deriving `login` server-side — nothing here trusts
 * client-supplied identity.
 */



// `HINTS_AVAILABLE` (capability: Upstash credentials present) and the policy
// reads built on it are in hint-config.ts — see the re-export above.

/** Default anti-burner gate: you must have solved at least this many
 *  challenges ON THE TARGET before you may buy that target's hints.
 *
 *  Why: a hint's PRICE lands on the account that reveals it, but the hint
 *  TEXT is trivially relayed — so a throwaway account can buy hints, eat a
 *  penalty nobody cares about, and pass the text to the real team. Pricing
 *  alone cannot stop that. Requiring earned progress can: a fresh account has
 *  no solves, so it can never reveal anything, and farming hints costs the
 *  same real work the event is scored on. 0 disables the gate. */


/** Default minutes after `scoringStartsAt` before ANY hint may be bought.
 *  0 = no time phase (the schedule is opt-in per event). Inert when no
 *  `scoringStartsAt` is configured — there is no phase without a start. */


const userHintsKey = (login: string) => `ctf:user:${login}:hints`;

/** Where a target's hint texts live. Classic hints sit in the site-owned
 *  `ctf:classic:hints` hash, written by classic-store's authoring path
 *  (#190); ai hints in the site-owned `ctf:ai:hints` hash, same reasoning.
 *  There is no secure-development arm, because nothing writes one (#334).
 *  One reveal/charge/penalty machinery serves all three — the default
 *  `hints:${target}` template is secure-dev's shape only, so classic and ai
 *  each need an explicit arm or a reveal would silently read an empty hash. */
const hintHashKey = (target: HintTarget) =>
  target === "classic" ? CLASSIC_HINTS_KEY : target === "ai" ? AI_HINTS_KEY : `hints:${target}`;

/** Catalogue ids look like "Challenge-5-Admin-Section" — reject anything
 *  weirder before it reaches Redis. */
const CHALLENGE_ID_RE = /^[\w.-]{1,128}$/;

export function isAppId(value: string): value is AppId {
  return value in appsById;
}

/** Everything a hint can be bought against: a secure-development target, the
 *  classic board (whose hints are per-challenge but gated board-wide —
 *  categories are display groupings, not progress domains), or the ai
 *  module (same board-wide gating as classic). */
export type HintTarget = AppId | "classic" | "ai";

export function isHintTarget(value: string): value is HintTarget {
  return value === "classic" || value === "ai" || isAppId(value);
}

// Charge-if-new + return the hint in one atomic script: SADD's return value
// is the idempotency guard, so a double-click (or a race across two tabs)
// can never charge twice. `hint` is re-checked inside the script — a stale
// availability cache can't charge for a hint that no longer exists.
// KEYS: [1]=user's hint set [2]=spend hash [3]=app hint catalogue [4]=purchase times
//       [5]=the shared score revision and [6]=the score-lowering in-progress
//       counter (#553, fold-cache.ts); [7]=the admin settings hash (#566: the
//       live `paused` flag); [8..]=the story lock's teammate solves hashes
//       (#463), when any.
// ARGV: [1]=challengeId [2]=<app>/<id> [3]=login [4]=cost [5]=now (ISO)
//       [6]="1" for a DRY RUN (#464 admin preview): read the text, write
//       nothing — no SADD, no charge, no purchase time.
//       [7]=story prerequisite (#463), "" when none — open only if a TEAMMATE
//       (a solves hash in KEYS[5..]) holds it; checked before any charge.
//       [8]=the contestant's gross score (#553), "" when hints are free. The
//       charge is refused unless gross − the spend read HERE ≥ cost: the
//       gate's own read is a separate round-trip, so two parallel reveals
//       could both pass it on the same figure and both charge — this re-check
//       is what makes the limit atomic. A hint already in KEYS[1] is exempt
//       (a re-view charges nothing). Gross may be ~10 s stale (the fold's
//       memo) — stale can only mean points not yet counted, conservative,
//       EXCEPT when a score-lowering write landed meanwhile, which [9] catches.
//       The spend side is never stale: read here.
//       [9]=the score revision the gross in [8] was folded under (fold-cache.ts
//       bumps KEYS[5] before and after every score-lowering operation, on any
//       app task, and holds KEYS[6] up while one runs). If the revision has
//       moved, or an operation is running, the gross may be too high: the
//       script answers `stale` before reading the spend or charging, and the
//       caller re-reads and retries once. "" (no gross) skips the check.
//       [10]=the scheduled scoring END as epoch ms (#566), "" when none. The
//       gate checked the window one round-trip earlier; a reveal that passed
//       it just before the end (or the freeze) must still not charge after
//       it, so the script compares Redis's own clock (TIME) to this instant
//       and reads the live `paused` flag from KEYS[7] right before the
//       charge — the closure is enforced where the write happens. Answers
//       `closed` with the reason; an owned hint is exempt (a re-view charges
//       nothing, so there is nothing to close).
//
// Every non-preview verdict's third element is the spend TOTAL after the
// call (case-folded, see the script) — what `balance` is derived from.
// Exported for the live suite only.
export const REVEAL_SCRIPT = `
-- The story lock (#463) comes FIRST: a locked step's hint is never read.
if ARGV[6] ~= '1' and ARGV[7] and ARGV[7] ~= '' then
  local open = false
  for i = 8, #KEYS do
    if redis.call('HEXISTS', KEYS[i], ARGV[7]) == 1 then open = true break end
  end
  if not open then return {'locked'} end
end
-- Existence is a FIELD check, not a read: the text is the protected thing,
-- and a buyer the checks below refuse must not have read it on the way —
-- not even into a Lua local (the contestant secrecy boundary). The admin
-- preview (dry run, #464) is the one path that reads before the checks: it
-- runs behind the admin gate and charges nothing.
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 0 then return {'missing'} end
if ARGV[6] == '1' then return {'preview', redis.call('HGET', KEYS[3], ARGV[1]), '0'} end
-- Scoring window (#566), enforced at the charge boundary: the gate's own
-- check was a separate round-trip, so a reveal that passed it just before
-- the scheduled end (or the freeze) could still charge after it. Redis's
-- clock against ARGV[10] (the end, epoch ms) and the live freeze flag in the
-- settings hash (KEYS[7]) decide HERE. The end wins over the freeze. An owned
-- hint is exempt — a re-view charges nothing, so there is nothing to close.
local owned = redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1
if not owned then
  if ARGV[10] and ARGV[10] ~= '' then
    local t = redis.call('TIME')
    local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
    if nowMs > tonumber(ARGV[10]) then return {'closed', 'ended'} end
  end
  if redis.call('HGET', KEYS[7], 'paused') == '1' then return {'closed', 'paused'} end
end
-- The gross in ARGV[8] was folded under the score revision in ARGV[9]. A
-- score-lowering operation on ANY app task bumps KEYS[5] before its first
-- write and after its last, and holds KEYS[6] up in between; if the revision
-- has moved, or an operation is running, that gross may be too high — refuse
-- before reading the spend or charging, and let the caller re-read and retry.
if ARGV[9] and ARGV[9] ~= '' then
  if (tonumber(redis.call('GET', KEYS[6]) or '0') or 0) > 0 then return {'stale'} end
  if (redis.call('GET', KEYS[5]) or '0') ~= ARGV[9] then return {'stale'} end
end
-- The spend total, CASE-FOLDED: one person's purchases can sit under two
-- spellings of their login (a case-only rename), and a single-field read by
-- the session's spelling would undercount. Read once, before the set guard,
-- for both the affordability re-check and the total every verdict returns.
local spent = 0
local all = redis.call('HGETALL', KEYS[2])
local me = string.lower(ARGV[3])
for i = 1, #all, 2 do
  if string.lower(all[i]) == me then spent = spent + (tonumber(all[i + 1]) or 0) end
end
if ARGV[8] and ARGV[8] ~= '' and not owned then
  if tonumber(ARGV[8]) - spent < tonumber(ARGV[4]) then return {'insufficient', '', spent} end
end
-- Every check that can refuse has passed: only now is the text read.
local hint = redis.call('HGET', KEYS[3], ARGV[1])
if redis.call('SADD', KEYS[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[2], ARGV[3], ARGV[4])
  redis.call('HSETNX', KEYS[4], ARGV[2], ARGV[5])
  return {'charged', hint, spent + tonumber(ARGV[4])}
end
return {'owned', hint, spent}`;

export type RevealResult =
  // `dryRun`: an admin-preview reveal (#464) — nothing was charged or recorded.
  // `cost` is the price THIS reveal resolved and charged the Lua with, so a
  // caller reports the amount actually deducted — never a second
  // `resolveHintConfig()` read that an organizer could have changed in between.
  // `balance` (#553): the contestant's net score AFTER this reveal, clamped
  // at 0 like the board, when the affordability gate read one (a priced hint,
  // not a preview) — so the page can say what is left next to the cost. A
  // LOWER BOUND: gross is the fold's figure, and a solve landing between the
  // fold and the charge is not in it (score awards do not bump the score
  // revision — every solve would otherwise force concurrent buyers to retry).
  // Awards only add, so the figure is never overstated; the page refresh
  // after the reveal shows the live score.
  | { ok: true; hint: string; alreadyOwned: boolean; spent: number; cost: number; balance?: number; dryRun?: true }
  | { ok: false; error: string; missing?: boolean; forbidden?: boolean };

/** Solves `login` has recorded for `app`, counted straight off the scorer's
 *  `ctf:solves:<target>` hash (fields are `<author>:<challengeId>`). Compared
 *  case-insensitively because GitHub logins are, while the stored field keeps
 *  whatever casing the PR author used. */
async function countSolves(login: string, target: HintTarget): Promise<number> {
  // Classic and ai: the anti-burner gate counts solves on the WHOLE board —
  // the per-login solves hash has one field per solved challenge (#190),
  // same shape for ai (issue #211) — NOT secure-dev's shared
  // `ctf:solves:<target>` hash the default arm below assumes.
  if (target === "classic") {
    const [res] = await upstashPipeline([["HLEN", classicSolvesKey(login)]]);
    return Number(res.result) || 0;
  }
  if (target === "ai") {
    const [res] = await upstashPipeline([["HLEN", aiSolvesKey(login)]]);
    return Number(res.result) || 0;
  }
  const [res] = await upstashPipeline([["HKEYS", `ctf:solves:${target}`]]);
  const fields = Array.isArray(res.result) ? (res.result as string[]) : [];
  const prefix = `${login.toLowerCase()}:`;
  return fields.filter((f) => f.toLowerCase().startsWith(prefix)).length;
}

export type HintGate =
  /** `balance` is present when the affordability gate ran (a priced hint,
   *  not a preview): the figures `revealHint` reports the resulting score from. */
  | { allowed: true; balance?: HintBalance }
  | { allowed: false; reason: "disabled" }
  // #566: scoring is closed — the manual freeze, or a passed scheduled end
  // (`ended`). A paid reveal lowers the buyer's net, so it closes with
  // scoring exactly as a flag or quiz submit does.
  | { allowed: false; reason: "paused" | "ended" }
  /** The event's hint phase hasn't opened yet. */
  | { allowed: false; reason: "locked"; unlocksAt: string }
  /** Caller hasn't earned enough on this target yet (the anti-burner gate). */
  | { allowed: false; reason: "no-progress"; needed: number; have: number }
  /** Caller cannot pay the price (#553): `have` is their net score, clamped at 0. */
  | { allowed: false; reason: "insufficient"; needed: number; have: number }
  /** A score-lowering admin operation is running somewhere (#553): no gross
   *  can be vouched for until it ends. Closed, and not an affordability answer. */
  | { allowed: false; reason: "busy" }
  /** The balance could not be read at all — a fold or Redis failure (#553).
   *  Closed, like every hint read, but NOT reported as a balance: "you have
   *  0" would be an invented figure. The caller says "try again". */
  | { allowed: false; reason: "unavailable" };

/** The affordability refusal (#553), worded once: the gate and the script's
 *  atomic re-check both end here. */
const notEnough = (needed: number, have: number) => `Not enough points: this hint costs ${needed} and you have ${have}`;

/** The scoring-window refusals (#566/#567), worded once: the gate and the
 *  script's charge-boundary re-check both end here. A pause is temporary,
 *  the end is final — never "until it resumes" for an event that is over. */
const HINTS_PAUSED_MESSAGE = "Scoring is paused right now — hints can't be bought until it resumes";
const HINTS_ENDED_MESSAGE = "Scoring has closed — the event has ended, so hints can no longer be bought";
/** The admin settings hash the script reads the live `paused` flag from
 *  (KEYS[7]). The same key `admin-store.ts` exports as ADMIN_SETTINGS_KEY —
 *  spelled here because this module must stay importable with admin-store
 *  mocked down to `getAdminSettings` (the store's tests do exactly that).
 *  hint-store.test.ts pins the two spellings against each other. */
export const HINT_SETTINGS_KEY = "ctf:admin:settings";

/** Whether `login` already bought `<target>/<id>` — the same set membership
 *  the reveal script's SADD guard decides on. Redis trouble reads as NOT
 *  owned (closed: the caller then refuses on price), with the error logged. */
async function ownsHint(login: string, target: HintTarget, id: string): Promise<boolean> {
  try {
    const [res] = await upstashPipeline([["SISMEMBER", userHintsKey(login), `${target}/${id}`]]);
    if (res.error !== undefined) throw new Error(res.error);
    return Number(res.result) === 1;
  } catch (err) {
    console.error("hint gate: ownership lookup failed:", errorLabel(err));
    return false;
  }
}

/** Decides whether `login` may buy a hint on `app` right now. Every gate is
 *  evaluated at READ time (no scheduler on the box), matching how the freeze
 *  and registration windows work. `id` names the specific hint when the
 *  caller has one: it only matters to the affordability gate, which lets an
 *  already-owned hint through regardless of price (a re-view charges nothing). */
export async function hintGate(
  login: string,
  target: HintTarget,
  opts: { dryRun?: boolean; id?: string } = {},
): Promise<HintGate> {
  // Per-target module gate: a target whose module is off has nothing to
  // sell, so the gate refuses. The module READ itself is not the closed
  // side of that — `isModuleLive`/`getEnabledModuleIds` fail OPEN to this
  // deployment's default set on a settings-read failure, same as every
  // other module consumer; only a module that answers "off" is refused
  // here. (The quiz has no hints by design — a question's hint is its
  // choices.)
  const targetModule = target === "classic" ? "classic" : target === "ai" ? "ai" : "secure-development";
  if (!(await isModuleLive(targetModule))) {
    return { allowed: false, reason: "disabled" };
  }

  const { enabled, cost, minSolves, unlockAfterMin, scoringStartsAt, paused, scoringEndsAt } =
    await resolveHintConfig();
  if (!enabled) return { allowed: false, reason: "disabled" };
  // A preview (#464: an admin before launch) is not buying anything, so the
  // time and anti-burner gates — both about when a PURCHASE is fair — do not
  // apply to it. Module-live and hints-enabled still do.
  if (opts.dryRun) return { allowed: true };

  // Scoring window (#566). A purchase lowers the buyer's net, so it is a
  // scoring action and closes with scoring: the manual freeze, and the
  // scheduled END once it has passed (`ended`, so the contestant reads
  // "over", not "try again later" — #567). NOT the not-launched case: the
  // route's launch lock (#464) owns that, and an unset start is also every
  // pre-launch admin preview's state. Before the time/progress/affordability
  // gates on purpose — a closed event answers "closed", not "solve more" or
  // "not enough", and no fold is read for a refusal the schedule already
  // made. The one exemption is a hint this login already owns: a re-view
  // charges nothing, so there is nothing to freeze.
  // The end wins over the freeze (CodeRabbit #568): both at once is still
  // the end of the event, and "until it resumes" would be a false promise.
  const closedBecause = scoringEnded(Date.now(), scoringEndsAt) ? "ended" : paused ? "paused" : null;
  if (closedBecause) {
    if (opts.id && (await ownsHint(login, target, opts.id))) return { allowed: true };
    return { allowed: false, reason: closedBecause };
  }

  // Time phase: only meaningful once the organizer has set a scoring start.
  if (unlockAfterMin > 0 && scoringStartsAt) {
    const startMs = Date.parse(scoringStartsAt);
    if (Number.isFinite(startMs)) {
      const opensMs = startMs + unlockAfterMin * 60_000;
      if (Date.now() < opensMs) {
        return { allowed: false, reason: "locked", unlocksAt: new Date(opensMs).toISOString() };
      }
    }
  }

  // Progress gate. Redis trouble fails CLOSED here (unlike the scoring freeze,
  // which must never drop live submissions): a hint is a paid reveal, so the
  // safe failure is "no hint", not "free hint for an unverified account".
  if (minSolves > 0) {
    let have: number;
    try {
      have = await countSolves(login, target);
    } catch (err) {
      console.error("hint gate: solve lookup failed:", errorLabel(err));
      return { allowed: false, reason: "no-progress", needed: minSolves, have: 0 };
    }
    if (have < minSolves) return { allowed: false, reason: "no-progress", needed: minSolves, have };
  }

  // Affordability (#553). The board floors a net score at 0, so without this
  // a contestant at 5 pts could buy a 10-pt hint and have the difference
  // quietly forgiven. `hintBalance` is the folded all-module total net of
  // spend — the figure the leaderboard shows — with the spend read fresh.
  // Fails CLOSED like the progress gate: an unreadable balance is "no hint",
  // never "free hint". After the progress gate on purpose: a burner is told
  // about solves, not points, and the fold is not read for a refusal the
  // cheaper gate already made. An owned hint is exempt when the caller names
  // it — a re-view charges nothing (the script's `owned` branch), so the
  // price is not its business; checked only on a short balance, so the common
  // path costs no extra round-trip.
  if (cost > 0) {
    let balance: HintBalance;
    try {
      balance = await hintBalance(login);
    } catch (err) {
      // A reset or module switch mid-flight on some app task: not a balance
      // answer, and the contestant is told what is going on. By NAME — the
      // tests reload modules, and a class identity does not survive that.
      if (err instanceof Error && err.name === "ScoreLoweringInProgress") return { allowed: false, reason: "busy" };
      // Closed — but as "could not check", not as a balance of 0: the
      // contestant may well have the points, the server just cannot verify it.
      console.error("hint gate: balance lookup failed:", errorLabel(err));
      return { allowed: false, reason: "unavailable" };
    }
    if (balance.net < cost) {
      if (opts.id && (await ownsHint(login, target, opts.id))) return { allowed: true, balance };
      return { allowed: false, reason: "insufficient", needed: cost, have: Math.max(0, balance.net) };
    }
    return { allowed: true, balance };
  }

  return { allowed: true };
}

export async function revealHint(
  login: string,
  target: string,
  id: string,
  opts: { dryRun?: boolean } = {},
): Promise<RevealResult> {
  const dryRun = opts.dryRun === true;
  // Fails CLOSED: unlike the scoring freeze, a settings-read error here must
  // never let a purchase through unpriced/ungated — `resolveHintConfig`'s
  // `getAdminSettings` throws on any read failure (transport or per-command),
  // which propagates out of this function uncaught, so no charge is ever
  // attempted. See docs/reviewing.md's fail-direction table.
  const { enabled, cost, scoringEndsAt } = await resolveHintConfig();
  if (!enabled) return { ok: false, error: "Hints are not enabled" };
  if (!isHintTarget(target)) return { ok: false, error: "Unknown app" };
  if (!CHALLENGE_ID_RE.test(id)) return { ok: false, error: "Invalid challenge id" };
  // The scheduled end as the script will compare it (#566): epoch ms, or
  // null when none is set / it does not parse (no end = no end, as
  // `outsideWindow` reads it).
  const endsAtParsed = scoringEndsAt ? Date.parse(scoringEndsAt) : NaN;
  const endsAtMs = Number.isFinite(endsAtParsed) ? endsAtParsed : null;

  // One attempt = gate, story lock, script. Re-run ONCE when the script
  // answers `stale` (a score-lowering write on some app task landed between
  // the gate's fold and the charge): the second attempt folds afresh under
  // the new revision. Twice stale is an event in the middle of a reset — tell
  // the contestant to try again rather than spin.
  return attemptReveal(login, target, id, cost, dryRun, endsAtMs, false);
}

async function attemptReveal(
  login: string,
  target: HintTarget,
  id: string,
  cost: number,
  dryRun: boolean,
  endsAtMs: number | null,
  retried: boolean,
): Promise<RevealResult> {
  // Gate BEFORE the charge script. Enforced here (not just in the route) so
  // every caller goes through it — the UI hides locked hints, but the API is
  // the boundary that actually decides.
  const gate = await hintGate(login, target, { dryRun, id });
  if (!gate.allowed) {
    // #566/#567: a closed event, worded apart — a pause is temporary, the
    // end is final — and `forbidden` so the route answers 403 like a submit.
    if (gate.reason === "paused") return { ok: false, forbidden: true, error: HINTS_PAUSED_MESSAGE };
    if (gate.reason === "ended") return { ok: false, forbidden: true, error: HINTS_ENDED_MESSAGE };
    if (gate.reason === "locked") {
      return { ok: false, forbidden: true, error: `Hints unlock at ${gate.unlocksAt}` };
    }
    if (gate.reason === "no-progress") {
      return {
        ok: false,
        forbidden: true,
        error: `Solve ${gate.needed} challenge${gate.needed === 1 ? "" : "s"} on this target before buying its hints (you have ${gate.have})`,
      };
    }
    if (gate.reason === "insufficient") {
      return { ok: false, forbidden: true, error: notEnough(gate.needed, gate.have) };
    }
    if (gate.reason === "busy") {
      return { ok: false, error: "Scores are being updated. Try again in a moment" };
    }
    if (gate.reason === "unavailable") {
      return { ok: false, error: "Couldn't check your score right now. Try again" };
    }
    return { ok: false, error: "Hints are not enabled" };
  }

  // STORY LOCK (#463): a classic hint for a later story step is refused by
  // the script unless a teammate solved the step before it. Resolved here,
  // enforced there; a stories/team read failure refuses (closed).
  let prereq = "";
  let lockKeys: string[] = [];
  if (target === "classic") {
    try {
      const [stories, existing] = await Promise.all([listStories(), listChallengeIds()]);
      const pos = storyPositions(stories, existing).get(id);
      if (pos?.prereq) {
        prereq = pos.prereq;
        lockKeys = await teamSolveKeys(login);
      }
    } catch (err) {
      console.error("Hint reveal: story lock lookup failed (failing closed):", errorLabel(err));
      return { ok: false, error: "Hint reveal failed. Try again" };
    }
  }

  let verdict: unknown;
  try {
    verdict = await upstashEval(
      REVEAL_SCRIPT,
      [
        userHintsKey(login),
        HINTS_SPENT_KEY,
        hintHashKey(target),
        userHintTimesKey(login),
        SCORE_REV_KEY,
        SCORE_LOWERING_KEY,
        // KEYS[7]: the settings hash, for the live `paused` flag at the
        // charge boundary (#566). The lock keys follow it.
        HINT_SETTINGS_KEY,
        ...lockKeys,
      ],
      [
        id,
        `${target}/${id}`,
        login,
        cost,
        new Date().toISOString(),
        dryRun ? "1" : "0",
        prereq,
        // ARGV[8]: the gross the gate read, for the script's atomic re-check;
        // ARGV[9]: the score revision it was folded under. Absent (free hint
        // / preview) the script skips both.
        gate.balance ? gate.balance.gross : "",
        gate.balance ? gate.balance.rev : "",
        // ARGV[10]: the scheduled end as epoch ms, compared to Redis's clock
        // right before the charge (#566). "" when no end is set.
        endsAtMs === null ? "" : String(endsAtMs),
      ],
    );
  } catch (err) {
    console.error("Hint reveal failed:", errorLabel(err));
    return { ok: false, error: "Hint reveal failed. Try again" };
  }

  const [status, hint, spent] = Array.isArray(verdict) ? (verdict as unknown[]) : [];
  if (status === "missing") {
    return { ok: false, missing: true, error: "No hint available for this challenge" };
  }
  // Exactly a missing hint (CodeRabbit #470): a distinct refusal would
  // confirm that a guessed id is a locked story step.
  if (status === "locked") {
    return { ok: false, missing: true, error: "No hint available for this challenge" };
  }
  // The score revision moved between the gate's fold and the charge (ARGV[9]):
  // the gross may be too high. Fold again under the new revision, once.
  if (status === "stale") {
    if (!retried) return attemptReveal(login, target, id, cost, dryRun, endsAtMs, true);
    return { ok: false, error: "Your score changed while buying this hint. Try again" };
  }
  // The script's charge-boundary window check (#566): the gate passed a
  // round-trip ago, the end (or the freeze) landed since. Same two messages
  // the gate gives; nothing was written.
  if (status === "closed") {
    return { ok: false, forbidden: true, error: hint === "ended" ? HINTS_ENDED_MESSAGE : HINTS_PAUSED_MESSAGE };
  }
  // The script's own re-check lost a race to a parallel purchase (ARGV[8]):
  // the same refusal the gate gives, from the spend the script actually saw.
  if (status === "insufficient") {
    const have = gate.balance ? Math.max(0, gate.balance.gross - (Number(spent) || 0)) : 0;
    return { ok: false, forbidden: true, error: notEnough(cost, have) };
  }
  if (status === "preview" && typeof hint === "string") {
    return { ok: true, hint, alreadyOwned: false, spent: 0, cost, dryRun: true };
  }
  if ((status === "charged" || status === "owned") && typeof hint === "string") {
    const alreadyOwned = status === "owned";
    // The resulting score (#553): the gate's gross less the spend total the
    // SCRIPT saw after this reveal (post-charge, case-folded) — not the gate's
    // own earlier read, which a parallel reveal may have outdated. Clamped
    // like the board. Absent when no balance was read (a free hint).
    const balance = gate.balance ? Math.max(0, gate.balance.gross - (Number(spent) || 0)) : undefined;
    return {
      ok: true,
      hint,
      alreadyOwned,
      spent: Number(spent) || 0,
      cost,
      ...(balance !== undefined ? { balance } : {}),
    };
  }
  return { ok: false, error: "Hint reveal failed. Try again" };
}

export type ViewerHints = {
  /** Bought hints with their texts, grouped by app and keyed by challenge id. */
  purchased: Partial<Record<AppId, Record<string, string>>>;
  /** Bought CLASSIC hints, keyed by challenge id (#190). */
  classic: Record<string, string>;
  /** Bought AI hints, keyed by challenge id (issue #211). */
  ai: Record<string, string>;
  /** Total penalty points. */
  spent: number;
  /** Hints bought. */
  count: number;
};

const NO_HINTS: ViewerHints = { purchased: {}, classic: {}, ai: {}, spent: 0, count: 0 };

export async function getViewerHints(login: string): Promise<ViewerHints> {
  // Cheap capability check first — no credentials means no settings read.
  if (!HINTS_AVAILABLE) return NO_HINTS;
  if (!(await resolveHintConfig()).enabled) return NO_HINTS;

  const [members, spentRes] = await upstashPipeline([
    ["SMEMBERS", userHintsKey(login)],
    ["HGET", HINTS_SPENT_KEY, login],
  ]);
  const owned = (Array.isArray(members.result) ? (members.result as string[]) : []).flatMap((member) => {
    const slash = member.indexOf("/");
    if (slash === -1) return [];
    const target = member.slice(0, slash);
    return isHintTarget(target) ? [{ target, id: member.slice(slash + 1) }] : [];
  });
  const spent = Number(spentRes.result) || 0;

  const purchased: ViewerHints["purchased"] = {};
  const classic: ViewerHints["classic"] = {};
  const ai: ViewerHints["ai"] = {};
  if (owned.length > 0) {
    const texts = (await upstashPipeline(owned.map(({ target, id }) => ["HGET", hintHashKey(target), id]))).map(
      ({ result }) => (typeof result === "string" && result ? result : null),
    );
    owned.forEach(({ target, id }, i) => {
      const text = texts[i];
      // A hint deleted after purchase just drops out of the reveal list.
      if (!text) return;
      if (target === "classic") classic[id] = text;
      else if (target === "ai") ai[id] = text;
      else (purchased[target] ??= {})[id] = text;
    });
  }

  return {
    purchased,
    classic,
    ai,
    spent,
    count: owned.length,
  };
}

/** Which challenge ids have a hint, per secure-development target.
 *
 *  **Always empty, and reads nothing.** `apps` is the secure-development target
 *  list, so this function only ever described that module — and no code path in
 *  this kit writes a `hints:<app>` field. Not the scorer (it has no concept of a
 *  hint), not the admin panel (`admin-secure-dev-tab.tsx` has no hint field),
 *  not the rubrics. The transport bug behind it was real and is fixed (#313),
 *  but there was never a producer on the other end, so the honest answer is
 *  "this module has no hints" rather than a live read that can only come back
 *  empty and a banner reporting that as news (#334).
 *
 *  Kept as a function, returning the same shape, so the decision is one edit
 *  away if secure-development hints ever gain an author — the three candidate
 *  designs are in #334. `classic` and `ai` hints are unaffected and are read
 *  by `getClassicHintIds` / `getAiHintIds` below. */
export async function getHintAvailability(): Promise<Partial<Record<AppId, string[]>>> {
  return {};
}

/** Which classic challenge ids have a hint — public shape (no text), for the
 *  board's 💡 markers and the challenge page's purchase affordance. Degrades
 *  to [] on any failure so the board renders without the hint layer. */
export async function getClassicHintIds(): Promise<string[]> {
  if (!HINTS_AVAILABLE) return [];
  if (!(await isModuleLive("classic"))) return [];
  try {
    if (!(await resolveHintConfig()).enabled) return [];
    const [res] = await upstashPipeline([["HKEYS", CLASSIC_HINTS_KEY]]);
    return Array.isArray(res.result) ? (res.result as string[]) : [];
  } catch (err) {
    // The try now covers resolveHintConfig (→ getAdminSettings) as well as
    // the HKEYS read: a transient settings-read error used to reject
    // OUTSIDE this catch, which rejected the whole Promise.all callers run
    // it under (the /ai and /flags pages) and 500'd the public board instead
    // of degrading like every other read here.
    console.error("Classic hint availability fetch failed:", errorLabel(err));
    return [];
  }
}

/** Which ai challenge ids have a hint — public shape (no text), mirroring
 *  `getClassicHintIds` (issue #211). Degrades to [] on any failure so the
 *  board renders without the hint layer. */
export async function getAiHintIds(): Promise<string[]> {
  if (!HINTS_AVAILABLE) return [];
  if (!(await isModuleLive("ai"))) return [];
  try {
    if (!(await resolveHintConfig()).enabled) return [];
    const [res] = await upstashPipeline([["HKEYS", AI_HINTS_KEY]]);
    return Array.isArray(res.result) ? (res.result as string[]) : [];
  } catch (err) {
    // Mirrors getClassicHintIds exactly: the try widens to cover
    // resolveHintConfig (→ getAdminSettings), not just the HKEYS read, so a
    // settings-read blip degrades to [] here instead of rejecting the
    // Promise.all callers (the /ai and /flags pages) run it under.
    console.error("AI hint availability fetch failed:", errorLabel(err));
    return [];
  }
}
