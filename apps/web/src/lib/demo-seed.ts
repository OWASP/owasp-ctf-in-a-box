// Demo seeding and clearing — the section that was 43% of admin-store.ts
// (#504 M9), moved out whole so the store stays about the settings, the audit
// trail and the runtime admins everything else reads.
//
// Two of the things this body needs live in admin-store.ts, so it is handed
// rather than imported:
//
//   - the settings snapshot, as a parameter. `getAdminSettings` is defined
//     there and this file is imported BY there (for the thin `seedDemoData`
//     wrapper below and the `clearDemoData` re-export), so importing it back
//     would be a cycle — the exact one `module-defaults.ts` exists to keep
//     admin-store out of. `clearDemoData` reads no settings and takes none.
//   - the audit trail's key and cap, from the dependency-free
//     `admin-audit-keys.ts` leaf, so this stays importable without the store.
//
// `adminErrorLabel` in the old home was `errorLabel` re-exported under a
// different name (#500), so the three log sites here call `errorLabel`
// directly — same function object, same output.
import "server-only";
import { createHash } from "node:crypto";

import { upstashPipeline } from "@/lib/upstash";
import { addUpload, fillMissingUpload, listAttachments } from "@/lib/attachments-store";
import { errorLabel } from "@/lib/error-label";
import { beginScoreLowering, endScoreLowering } from "@/lib/leaderboard/fold-cache";
import { defaultEnabledModules } from "@/lib/module-defaults";
import { ADMIN_AUDIT_KEY, AUDIT_CAP } from "@/lib/admin-audit-keys";
import type { AdminSettings } from "@/lib/admin-store";
import {
  DEMO_CONTESTANTS,
  DEMO_TEAMS,
  DEMO_QUESTIONS,
  DEMO_QUIZ_ANSWERS,
  DEMO_CHALLENGES,
  DEMO_CLASSIC_CATEGORIES,
  DEMO_CLASSIC_SOLVES,
  DEMO_CLASSIC_ATTACHMENTS,
  DEMO_AI_CHALLENGES,
  DEMO_AI_CATEGORIES,
  DEMO_AI_SOLVES,
  DEMO_SPONSORS,
} from "@/lib/demo-fixture";
import {
  QUIZ_QUESTIONS_KEY,
  QUIZ_KEY_KEY,
  QUIZ_POINTS_KEY,
  QUIZ_ANSWERED_KEY,
  QUIZ_LAST_AT_KEY,
  quizAnswersKey,
  quizAttemptsKey,
  canonicalizeChoices,
} from "@/lib/quiz-keys";
import {
  CLASSIC_CHALLENGES_KEY,
  CLASSIC_FLAG_KEY,
  CLASSIC_FLAGNORM_KEY,
  CLASSIC_CATEGORIES_KEY,
  CLASSIC_CATEGORIES_MAX,
  CLASSIC_POINTS_KEY,
  CLASSIC_SOLVED_KEY,
  CLASSIC_SOLVECOUNT_KEY,
  CLASSIC_LAST_AT_KEY,
  classicSolvesKey,
  classicAttemptsKey,
  normalizeFlag,
} from "@/lib/classic-keys";
import {
  AI_CHALLENGES_KEY,
  AI_FLAG_KEY,
  AI_FLAGNORM_KEY,
  AI_CATEGORIES_KEY,
  AI_CATEGORIES_MAX,
  AI_SIGNKEY_KEY,
  AI_HINTS_KEY,
  AI_POINTS_KEY,
  AI_SOLVED_KEY,
  AI_SOLVECOUNT_KEY,
  AI_LAST_AT_KEY,
  aiSolvesKey,
  aiAttemptsKey,
  flagComparisonForm,
} from "@/lib/ai-keys";
import { SPONSORS_KEY, SPONSORS_LOGO_KEY } from "@/lib/sponsors-keys";

// --- demo seed / clear (admin-gated dangerous settings, issue #419) ---------

/**
 * One attempt row in the shape quiz-store's and classic-store's live attempt
 * scripts write: `{attempts, firstAt, lastAt, lastAtMs}`.
 *
 * The seed banks earned rows directly instead of replaying a submission, so
 * without this it produced an event in which nobody had ever *tried* anything:
 * the Insights tab showed a 100% solve rate, "1.0" average tries and a blank
 * median time on every single challenge. That is the same class of gap as the
 * membership timestamps the seed used to skip (ADR 49) — a fixture that
 * bypasses the live write path also bypasses the telemetry that path records,
 * and the first event a new organizer looks at is a seeded one.
 *
 * `firstAt` is derived BACKWARDS from the known earn time, so the ordering the
 * metrics fold guards against (an item earned before its own first attempt)
 * cannot arise here. Deriving a start time forwards could overshoot the earn
 * time and be silently dropped from the median instead of failing loudly.
 *
 * Every row gets a nonzero head start, INCLUDING a one-try row. Deriving
 * `firstAt` from the gaps between tries alone means a first-try solve has
 * `firstAt === lastAt`, and the Insights tab duly reported a median
 * time-to-solve of **0s** — nobody has ever solved anything in zero seconds.
 * A first try is not the moment the contestant met the challenge; the reading
 * came first. So the head start is the time spent before the first submission,
 * and the per-try gaps stack on top of it.
 */
const DEMO_FIRST_TRY_MINUTES = 3;

function demoAttemptRow(tries: number, earnedAt: string, gapMinutes: number, floorMs?: number): string {
  const lastAtMs = Date.parse(earnedAt);
  const elapsedMinutes = DEMO_FIRST_TRY_MINUTES + (tries - 1) * gapMinutes;
  // Clamped to the seed window's start (the scoring open, when scheduled):
  // an earnedAt just inside the window minus a retry gap otherwise lands a
  // first attempt BEFORE scoring opened — the exact contradiction the window
  // clamp exists to prevent.
  const firstAtMs = Math.max(lastAtMs - elapsedMinutes * 60_000, floorMs ?? Number.NEGATIVE_INFINITY);
  const firstAt = new Date(firstAtMs).toISOString();
  return JSON.stringify({ attempts: tries, firstAt, lastAt: earnedAt, lastAtMs });
}

// Per-challenge solver counts are RAISED, never set.
//
// Every other figure the seed writes is keyed by LOGIN, and the fixture owns
// those logins outright — an absolute HSET is what keeps a re-seed idempotent
// instead of doubling totals. `solvecount` is the exception: it is keyed by
// CHALLENGE and counts distinct solvers across everyone, so the fixture's
// number is a floor, not the truth. Writing it absolutely rewrote a real
// contestant's solve out of the public count on every re-seed — silently, since
// their own per-login row survived and still said "Solved" (issue #335).
//
// One EVAL rather than read-then-write so the raise is atomic: a solve landing
// mid-seed is counted, not lost to a stale read.
const RAISE_SOLVECOUNT_SCRIPT = `
local i = 1
while i <= #ARGV do
  local field, floor = ARGV[i], tonumber(ARGV[i + 1])
  local current = tonumber(redis.call('HGET', KEYS[1], field) or '0') or 0
  if current < floor then redis.call('HSET', KEYS[1], field, floor) end
  i = i + 2
end
return 1
`;

// Category lists are UNIONED, never replaced — for the same reason
// `solvecount` above is raised rather than set: the fixture's value is a
// floor, not the truth.
//
// The seed used to `SET` both lists to the demo fixture's, which deleted every
// category an organizer had authored. Their challenges survived (they are
// written per-field, keyed by id) and the admin panel kept listing them, but
// the contestant board renders only categories present in the list, so three
// authored AI challenges and 850 points of content silently left the board
// while "1 category · 5 challenges" read like a healthy setup (issue #344).
// Master reset is no way back: it deliberately preserves authored categories,
// so the list it preserves is the seeded one.
//
// ONE SCRIPT, not read-then-write. Upstash's `/pipeline` is not transactional,
// so a GET here and a SET later leaves a window in which an organizer's own
// category edit is read, ignored and overwritten. Worse, the fixture's
// challenge rows have to name a category the list actually holds, so a rename
// landing inside that window would orphan every row this seed just wrote —
// exactly the failure #344 is about. Both halves therefore happen inside the
// same EVAL, which Redis runs atomically: the union is computed against the
// list as it is at that instant, and the challenge records are written under
// whichever spelling that union kept.
//
// Membership is case-INSENSITIVE, mirroring `setCategories` and classic's
// `importBundle`: "AI" and "ai" as two headings is never what anyone meant,
// and the board's filter is exact equality, so two casings would also split
// challenges across them. The stored order is kept verbatim — it is the order
// the board renders headings in — and unseen fixture names are appended.
export const SEED_CATEGORIES_SCRIPT = `
local stored = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then
    for _, name in ipairs(decoded) do
      if type(name) == 'string' then stored[#stored + 1] = name end
    end
  end
end

-- The union, and the fold -> surviving-spelling map the rows below are
-- rewritten through. Existing spellings win: renaming the organizer's "ai" to
-- the fixture's "AI" would hide THEIR challenges instead of ours.
local canon = {}
local union = {}
for _, name in ipairs(stored) do
  local fold = string.lower(name)
  if canon[fold] == nil then
    canon[fold] = name
    union[#union + 1] = name
  end
end
for _, name in ipairs(cjson.decode(ARGV[1])) do
  local fold = string.lower(name)
  if canon[fold] == nil then
    canon[fold] = name
    union[#union + 1] = name
  end
end

-- Refuse rather than trim, BEFORE anything is written. Dropping the overflow
-- would orphan the fixture rows naming those categories, which is issue #344
-- from the other side; storing a list over the cap would make every later
-- category edit fail validation.
local max = tonumber(ARGV[2])
if #union > max then
  return redis.error_reply('seed would take the category list to ' .. #union .. ', over the limit of ' .. max)
end

-- cjson encodes an empty Lua table as an object, and this value is parsed as
-- an array everywhere it is read.
if #union == 0 then
  redis.call('SET', KEYS[1], '[]')
else
  redis.call('SET', KEYS[1], cjson.encode(union))
end

local written = 0
for i = 3, #ARGV do
  local record = cjson.decode(ARGV[i])
  local kept = canon[string.lower(record['category'])]
  if kept ~= nil then record['category'] = kept end
  redis.call('HSET', KEYS[2], record['id'], cjson.encode(record))
  written = written + 1
end
return written
`;

/** Queues one module's category union and the challenge records that depend on
 *  it. The records arrive already built FIELD BY FIELD by the caller — never a
 *  spread of the fixture object, which carries the flag beside them — and the
 *  script rewrites only their `category`. */
function seedCategoriesAndChallenges(
  cmds: (string | number)[][],
  categoriesKey: string,
  challengesKey: string,
  fixtureCategories: readonly string[],
  max: number,
  records: readonly { id: string; category: string }[],
): void {
  cmds.push([
    "EVAL",
    SEED_CATEGORIES_SCRIPT,
    2,
    categoriesKey,
    challengesKey,
    JSON.stringify(fixtureCategories),
    max,
    ...records.map((record) => JSON.stringify(record)),
  ]);
}

/** Queues the raise for one module's solvecount hash, or nothing when the
 *  fixture seeded no solves for it. */
function raiseSolveCounts(cmds: (string | number)[][], key: string, counts: Map<string, number>): void {
  if (counts.size === 0) return;
  const argv: (string | number)[] = [];
  for (const [challengeId, count] of counts) argv.push(challengeId, count);
  cmds.push(["EVAL", RAISE_SOLVECOUNT_SCRIPT, 1, key, ...argv]);
}

/**
 * Populate a demo leaderboard from the bundled fixture: real challenge-id solves
 * (so the scorer awards points), spread over the last ~6h for a rising
 * score-over-time graph, plus a few teams. When the quiz module is enabled,
 * also seeds a small demo question bank and a spread of correct answers
 * across the same contestants (timestamped inside the same ~6h window) so
 * the demo shows a genuinely combined two-module leaderboard. Additive —
 * does not clear first. Gated by the route on requireAdmin plus a
 * type-to-confirm (no DEMO_MODE env var since issue #419, ADR 58). It stays
 * reachable on a production box, so do not run it during a live event: the
 * demo contestants and solves land on the real board.
 */
async function seedDemoAttachments(): Promise<void> {
  for (const a of DEMO_CLASSIC_ATTACHMENTS) {
    const bytes = new Uint8Array(Buffer.from(a.base64, "base64"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const stored = await listAttachments("classic", a.challengeId);
    const match = stored.find((s) => s.kind === "upload" && s.sha256 === sha);
    // Present with its bytes: nothing to do. Present but MISSING (an imported
    // bundle carries metadata only): the right sha and no bytes, so fill it.
    if (match?.missing) await fillMissingUpload(match.id, bytes);
    else if (!match) await addUpload("classic", a.challengeId, a.name, bytes);
  }
}

export async function runDemoSeed(
  settings: AdminSettings,
  actor: string,
): Promise<{ contestants: number; teams: number; solves: number; sponsors: number }> {
  const now = Date.now();
  const windowMs = 6 * 60 * 60 * 1000;

  const cmds: (string | number)[][] = [];
  // The seed window: the last ~6h, CLAMPED to the scoring schedule when one
  // is set — a fixture stamped before "scoring opens" puts a full race on the
  // chart dated before the phase line says scoring existed, on exactly the
  // demo an organizer inspects first. The window ends at now (or the scoring
  // close, if that already passed) and starts no earlier than the scoring
  // open. A schedule entirely in the future has no valid past instant to
  // clamp to, so it falls back to the unclamped window — future-dated solves
  // would be a worse lie than a mistimed one.
  // Fail closed: the snapshot admin-store hands us now also decides WHICH
  // modules get demo rows (issue #386), so it gates a write. A settings blip
  // must abort the seed, not fall back to seeding every module's data
  // regardless of what the organizer actually enabled — let that read throw
  // and propagate.
  // The live module set, same read: which of quiz/classic/ai to seed demo
  // data for must follow what this event is actually serving (issue #386),
  // not what happened to be baked at build time.
  const live = new Set(settings.enabledModuleIds ?? defaultEnabledModules(process.env));
  // Secure Development demo data — only when the module is live, same gate
  // reasoning as quiz/classic/ai below: a deployment with no scorer image
  // (or one that switched the board off) must get a seed byte-for-byte
  // identical to having no secure-development data at all, not solve rows
  // for a board that isn't running.
  const secureDevLive = live.has("secure-development");
  let total = 0;
  if (secureDevLive) {
    for (const c of DEMO_CONTESTANTS) for (const ids of Object.values(c.solves)) total += ids.length;
  }
  const scoringStartMs = settings.scoringStartsAt ? Date.parse(settings.scoringStartsAt) : NaN;
  const scoringEndMs = settings.scoringEndsAt ? Date.parse(settings.scoringEndsAt) : NaN;
  let end = Number.isFinite(scoringEndMs) ? Math.min(now, scoringEndMs) : now;
  let base = Math.max(end - windowMs, Number.isFinite(scoringStartMs) ? scoringStartMs : end - windowMs);
  if (!(base < end)) {
    base = now - windowMs;
    end = now;
  }
  const spanMs = end - base;
  const n = DEMO_CONTESTANTS.length;
  // Spread EACH contestant's solves across the whole window (not a per-contestant
  // block), so every line rises throughout and they interleave. A per-contestant
  // sub-slot phase ((ci+0.5)/n) staggers otherwise-identical tick times so lines
  // don't land exactly on top of each other.
  if (secureDevLive) {
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const kc = Object.values(c.solves).reduce((m, ids) => m + ids.length, 0);
      let j = 0;
      for (const [target, ids] of Object.entries(c.solves)) {
        for (const id of ids) {
          const frac = kc > 0 ? (j + (ci + 0.5) / n) / kc : 0.5;
          const ts = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
          cmds.push(["HSET", `ctf:solves:${target}`, `${c.login}:${id}`, ts]);
          j++;
        }
      }
    });
  }
  const createdAt = new Date(base).toISOString();
  for (const t of DEMO_TEAMS) {
    cmds.push(["HSET", `ctf:team:${t.slug}`, "name", t.name, "captain", t.captain, "createdAt", createdAt, "joinCode", t.slug.slice(0, 6)]);
    if (t.members.length > 0) cmds.push(["SADD", `ctf:team:${t.slug}:members`, ...t.members]);
    // The membership timestamps too, not just the pointer. Seeding writes the
    // user hash directly rather than going through createTeam/joinTeam, so it
    // is the one path that can produce a member with no `joinedAt` and no
    // `firstTeamAt` — which made the Insights funnel report "ever on a team:
    // 0" beside "on a team: 6" on exactly the event a new organizer looks at
    // first (issue #169 / ADR 49).
    for (const m of t.members) {
      cmds.push([
        "HSET",
        `ctf:user:${m}`,
        "team",
        t.slug,
        "joinedAt",
        createdAt,
        "firstTeamAt",
        createdAt,
      ]);
    }
  }

  // Quiz demo data — only when the module is enabled, so a disabled quiz
  // module leaves the seed byte-for-byte identical to pre-quiz behavior.
  const quizEnabled = live.has("quiz");
  let quizAnswersSeeded = 0;
  if (quizEnabled) {
    // Write the public question + its correct-answer key with the SAME
    // shared `canonicalizeChoices` recipe quiz-store's upsertQuestion uses
    // (dedupe then sort into a JSON array) — GRADE_SCRIPT string-compares a
    // submission's canonicalized array against this key byte-for-byte, so
    // any other shape here would silently make every demo question
    // ungradeable.
    for (const { correct, ...question } of DEMO_QUESTIONS) {
      cmds.push(["HSET", QUIZ_QUESTIONS_KEY, question.id, JSON.stringify(question)]);
      cmds.push(["HSET", QUIZ_KEY_KEY, question.id, JSON.stringify(canonicalizeChoices(correct))]);
    }

    const questionsById = new Map(DEMO_QUESTIONS.map((q) => [q.id, q]));
    const aggregates = new Map<string, { points: number; answered: number; lastAt: string }>();
    const nAnswers = DEMO_QUIZ_ANSWERS.length;
    DEMO_QUIZ_ANSWERS.forEach(({ login, questionId }, i) => {
      const q = questionsById.get(questionId);
      if (!q) return; // fixture-consistency guard; should never trigger
      const frac = nAnswers > 0 ? (i + 0.5) / nAnswers : 0.5;
      const at = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
      // Same shared recipe as the key above: a demo answer's banked
      // `choices` is always the question's full correct set (it's recorded
      // as correct), stored the same way GRADE_SCRIPT stores a live one.
      const choices = canonicalizeChoices(q.correct);
      cmds.push(["HSET", quizAnswersKey(login), questionId, JSON.stringify({ choices, points: q.points, at })]);
      // The tries it took, so "avg tries" and "median time" have something to
      // average. Counts and gaps cycle off the index rather than being random:
      // a seed that produced different numbers on each run would make the
      // Insights tab impossible to screenshot or assert against.
      cmds.push([
        "HSET",
        quizAttemptsKey(login),
        questionId,
        demoAttemptRow(1 + (i % 3), at, 3 + (i % 7), base),
      ]);

      const agg = aggregates.get(login) ?? { points: 0, answered: 0, lastAt: at };
      agg.points += q.points;
      agg.answered += 1;
      if (Date.parse(at) > Date.parse(agg.lastAt)) agg.lastAt = at;
      aggregates.set(login, agg);
      quizAnswersSeeded++;
    });
    // Attempts that never became answers. Without them every question sits at
    // a 100% solve rate, which reads as "this quiz was too easy" when what it
    // actually means is "nobody who failed was ever recorded". One missed
    // question per contestant who has one, chosen deterministically.
    const answeredBy = new Map<string, Set<string>>();
    for (const { login, questionId } of DEMO_QUIZ_ANSWERS) {
      const set = answeredBy.get(login) ?? new Set<string>();
      set.add(questionId);
      answeredBy.set(login, set);
    }
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const answered = answeredBy.get(c.login) ?? new Set<string>();
      const missed = DEMO_QUESTIONS.find((q) => !answered.has(q.id));
      if (!missed) return;
      const at = new Date(base + Math.min(0.999, (ci + 0.5) / n) * spanMs).toISOString();
      cmds.push(["HSET", quizAttemptsKey(c.login), missed.id, demoAttemptRow(1 + (ci % 2), at, 5 + (ci % 4), base)]);
    });

    // Aggregates are written as the final absolute total (not HINCRBY'd),
    // unlike GRADE_SCRIPT's live increments — the fixture already knows each
    // login's final total, and an absolute HSET keeps re-running the seed
    // idempotent instead of doubling the totals on a second seed.
    for (const [login, agg] of aggregates) {
      cmds.push(["HSET", QUIZ_POINTS_KEY, login, agg.points]);
      cmds.push(["HSET", QUIZ_ANSWERED_KEY, login, agg.answered]);
      // The latest row's time: what GRADE_SCRIPT would have left (#522).
      cmds.push(["HSET", QUIZ_LAST_AT_KEY, login, agg.lastAt]);
    }
  }

  // Classic demo data — only when the module is enabled, so a disabled
  // classic module leaves the seed byte-for-byte identical to pre-classic
  // behavior (same reasoning as the quiz gate above).
  const classicEnabled = live.has("classic");
  let classicSolvesSeeded = 0;
  if (classicEnabled) {
    // Public challenge record ONLY — built field by field from `Challenge`'s
    // own shape, never by spreading the fixture object, so the flag (which
    // lives alongside it on the fixture) has no path into
    // ctf:classic:challenges. The authored flag and its normalized form are
    // written into their own separate hashes in the SAME pipeline, exactly
    // as upsertChallenge does — normalizeFlag is the ONLY thing allowed to
    // produce ctf:classic:flagnorm's value; a hand-rolled lowercase here
    // would silently desync from what submitFlag compares against.
    const classicRecords = DEMO_CHALLENGES.map((dc) => ({
      id: dc.id,
      title: dc.title,
      // The fixture's spelling; the script rewrites it to whichever the union
      // kept, which is identical on a board that had no such category and
      // differs only on one that spells it its own way.
      category: dc.category,
      description: dc.description,
      points: dc.points,
      order: dc.order,
    }));
    // The records and the category list they depend on go in together — see
    // SEED_CATEGORIES_SCRIPT for why they cannot be a read and a later write.
    seedCategoriesAndChallenges(
      cmds,
      CLASSIC_CATEGORIES_KEY,
      CLASSIC_CHALLENGES_KEY,
      DEMO_CLASSIC_CATEGORIES,
      CLASSIC_CATEGORIES_MAX,
      classicRecords,
    );
    for (const dc of DEMO_CHALLENGES) {
      cmds.push(["HSET", CLASSIC_FLAG_KEY, dc.id, dc.flag]);
      cmds.push(["HSET", CLASSIC_FLAGNORM_KEY, dc.id, normalizeFlag(dc.flag)]);
    }

    const challengesById = new Map(DEMO_CHALLENGES.map((c) => [c.id, c]));
    const classicAggregates = new Map<string, { points: number; solved: number; lastAt: string }>();
    const solveCounts = new Map<string, number>();
    const nSolves = DEMO_CLASSIC_SOLVES.length;
    DEMO_CLASSIC_SOLVES.forEach(({ login, challengeId }, i) => {
      const challenge = challengesById.get(challengeId);
      if (!challenge) return; // fixture-consistency guard; should never trigger
      const frac = nSolves > 0 ? (i + 0.5) / nSolves : 0.5;
      const at = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
      cmds.push(["HSET", classicSolvesKey(login), challengeId, JSON.stringify({ points: challenge.points, at })]);
      // Same reasoning as the quiz attempt row above: index-derived, not random.
      cmds.push([
        "HSET",
        classicAttemptsKey(login),
        challengeId,
        demoAttemptRow(1 + ((i + 1) % 3), at, 2 + (i % 9), base),
      ]);

      const agg = classicAggregates.get(login) ?? { points: 0, solved: 0, lastAt: at };
      agg.points += challenge.points;
      agg.solved += 1;
      if (Date.parse(at) > Date.parse(agg.lastAt)) agg.lastAt = at;
      classicAggregates.set(login, agg);

      solveCounts.set(challengeId, (solveCounts.get(challengeId) ?? 0) + 1);
      classicSolvesSeeded++;
    });
    // Unsolved attempts, same reasoning as the quiz block above.
    const solvedBy = new Map<string, Set<string>>();
    for (const { login, challengeId } of DEMO_CLASSIC_SOLVES) {
      const set = solvedBy.get(login) ?? new Set<string>();
      set.add(challengeId);
      solvedBy.set(login, set);
    }
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const solved = solvedBy.get(c.login) ?? new Set<string>();
      const missed = DEMO_CHALLENGES.find((ch) => !solved.has(ch.id));
      if (!missed) return;
      const at = new Date(base + Math.min(0.999, (ci + 0.5) / n) * spanMs).toISOString();
      cmds.push(["HSET", classicAttemptsKey(c.login), missed.id, demoAttemptRow(2 + (ci % 3), at, 4 + (ci % 5), base)]);
    });

    // Aggregates written as the final absolute total (not HINCRBY'd), mirroring
    // the quiz aggregates above — idempotent on a second seed run.
    for (const [login, agg] of classicAggregates) {
      cmds.push(["HSET", CLASSIC_POINTS_KEY, login, agg.points]);
      cmds.push(["HSET", CLASSIC_SOLVED_KEY, login, agg.solved]);
      cmds.push(["HSET", CLASSIC_LAST_AT_KEY, login, agg.lastAt]);
    }
    raiseSolveCounts(cmds, CLASSIC_SOLVECOUNT_KEY, solveCounts);
  }

  // ai demo data — only when the module is enabled, same gate reasoning as
  // quiz and classic above: a disabled ai module leaves the seed byte-for-byte
  // identical to pre-ai behavior.
  //
  // Deliberately does NOT touch `AI_LAUNCHKEY_KEY`: that keypair is
  // module-wide identity material, minted lazily on first real use
  // (`getAiLaunchKeys` in ai-store.ts), never fixture data. Writing one here
  // would hand every seeded demo event the SAME hardcoded private key.
  const aiEnabled = live.has("ai");
  let aiSolvesSeeded = 0;
  if (aiEnabled) {
    // Public challenge record ONLY, built field by field from `AiChallenge`'s
    // own shape (mirrors the classic block above) — the flag and signing key
    // live in DEMO_AI_CHALLENGES only so this function can derive their
    // dedicated hashes, never by spreading the fixture object into
    // ctf:ai:challenges. An event-only challenge (`mode: "event"`) writes
    // NEITHER flag hash, matching how `upsertAiChallenge` treats a non-graded
    // mode: signed events assert that solve, so there is no flag to grade.
    const aiRecords = DEMO_AI_CHALLENGES.map((dc) => ({
      id: dc.id,
      title: dc.title,
      // The fixture's spelling — the script rewrites it, same as classic's.
      category: dc.category,
      description: dc.description,
      points: dc.points,
      order: dc.order,
      mode: dc.mode,
      urlTemplate: dc.urlTemplate,
    }));
    seedCategoriesAndChallenges(
      cmds,
      AI_CATEGORIES_KEY,
      AI_CHALLENGES_KEY,
      DEMO_AI_CATEGORIES,
      AI_CATEGORIES_MAX,
      aiRecords,
    );
    for (const dc of DEMO_AI_CHALLENGES) {
      if (dc.mode !== "event") {
        cmds.push(["HSET", AI_FLAG_KEY, dc.id, dc.flag]);
        cmds.push(["HSET", AI_FLAGNORM_KEY, dc.id, flagComparisonForm(dc.flag, dc.caseSensitive)]);
      }
      // A fixed, obviously-fake demo key rather than a fresh `generateSigningKey()`
      // mint — same choice the classic block above makes for its flag: a
      // reproducible fixture, not fresh CSPRNG output on every seed run.
      cmds.push(["HSET", AI_SIGNKEY_KEY, dc.id, dc.signingKey]);
      if (dc.hint) cmds.push(["HSET", AI_HINTS_KEY, dc.id, dc.hint]);
    }

    const aiChallengesById = new Map(DEMO_AI_CHALLENGES.map((c) => [c.id, c]));
    const aiAggregates = new Map<string, { points: number; solved: number; lastAt: string }>();
    const aiSolveCounts = new Map<string, number>();
    const nAiSolves = DEMO_AI_SOLVES.length;
    DEMO_AI_SOLVES.forEach(({ login, challengeId }, i) => {
      const challenge = aiChallengesById.get(challengeId);
      if (!challenge) return; // fixture-consistency guard; should never trigger
      const frac = nAiSolves > 0 ? (i + 0.5) / nAiSolves : 0.5;
      const at = new Date(base + Math.min(0.999, frac) * spanMs).toISOString();
      cmds.push(["HSET", aiSolvesKey(login), challengeId, JSON.stringify({ points: challenge.points, at })]);
      // Same reasoning as the quiz/classic attempt rows above: index-derived,
      // not random, so the seed is reproducible.
      cmds.push(["HSET", aiAttemptsKey(login), challengeId, demoAttemptRow(1 + ((i + 2) % 3), at, 3 + (i % 6), base)]);

      const agg = aiAggregates.get(login) ?? { points: 0, solved: 0, lastAt: at };
      agg.points += challenge.points;
      agg.solved += 1;
      if (Date.parse(at) > Date.parse(agg.lastAt)) agg.lastAt = at;
      aiAggregates.set(login, agg);

      aiSolveCounts.set(challengeId, (aiSolveCounts.get(challengeId) ?? 0) + 1);
      aiSolvesSeeded++;
    });
    // Unsolved attempts, same reasoning as the quiz/classic blocks above.
    const aiSolvedBy = new Map<string, Set<string>>();
    for (const { login, challengeId } of DEMO_AI_SOLVES) {
      const set = aiSolvedBy.get(login) ?? new Set<string>();
      set.add(challengeId);
      aiSolvedBy.set(login, set);
    }
    DEMO_CONTESTANTS.forEach((c, ci) => {
      const solved = aiSolvedBy.get(c.login) ?? new Set<string>();
      const missed = DEMO_AI_CHALLENGES.find((ch) => !solved.has(ch.id));
      if (!missed) return;
      const at = new Date(base + Math.min(0.999, (ci + 0.5) / n) * spanMs).toISOString();
      cmds.push(["HSET", aiAttemptsKey(c.login), missed.id, demoAttemptRow(2 + (ci % 2), at, 5 + (ci % 3), base)]);
    });

    // Aggregates written as the final absolute total (not HINCRBY'd), mirroring
    // the quiz/classic aggregates above — idempotent on a second seed run, and
    // CONSISTENT with the per-login solve rows and solvecount by construction
    // (both folded from the same DEMO_AI_SOLVES list in this same pass).
    for (const [login, agg] of aiAggregates) {
      cmds.push(["HSET", AI_POINTS_KEY, login, agg.points]);
      cmds.push(["HSET", AI_SOLVED_KEY, login, agg.solved]);
      cmds.push(["HSET", AI_LAST_AT_KEY, login, agg.lastAt]);
    }
    raiseSolveCounts(cmds, AI_SOLVECOUNT_KEY, aiSolveCounts);
  }

  // Sponsors — a platform feature, not a module, so unlike quiz/classic/ai
  // above this is never gated on `live`: an organizer previewing the demo
  // with every module off still sees what the sponsors feature looks like.
  // The logo's `bytes`/`etag` are derived from the fixture's own base64 data
  // here (same sha256-of-decoded-bytes recipe as sponsors-store.ts's
  // decodeAndValidateLogo), never hand-carried in the fixture, so the two
  // cannot silently drift apart.
  for (const s of DEMO_SPONSORS) {
    const logoBytes = Buffer.from(s.logo.data, "base64");
    const logo = {
      type: s.logo.type,
      bytes: logoBytes.length,
      w: s.logo.w,
      h: s.logo.h,
      etag: createHash("sha256").update(logoBytes).digest("hex").slice(0, 16),
    };
    cmds.push([
      "HSET",
      SPONSORS_KEY,
      s.id,
      JSON.stringify({ id: s.id, name: s.name, url: s.url, blurb: s.blurb, tier: s.tier, order: s.order, logo }),
    ]);
    cmds.push(["HSET", SPONSORS_LOGO_KEY, s.id, s.logo.data]);
  }

  const audit = JSON.stringify({
    at: new Date(now).toISOString(),
    by: actor,
    action: "seed",
    contestants: DEMO_CONTESTANTS.length,
    teams: DEMO_TEAMS.length,
    solves: total,
    ...(quizEnabled ? { quizQuestions: DEMO_QUESTIONS.length, quizAnswers: quizAnswersSeeded } : {}),
    ...(classicEnabled
      ? { classicChallenges: DEMO_CHALLENGES.length, classicSolves: classicSolvesSeeded }
      : {}),
    ...(aiEnabled ? { aiChallenges: DEMO_AI_CHALLENGES.length, aiSolves: aiSolvesSeeded } : {}),
    sponsors: DEMO_SPONSORS.length,
  });
  // Tracked BEFORE the two audit commands below, so their own failure is
  // checked separately: writeAdminAudit's own doc comment states the rule
  // this pipeline otherwise violates — "an audit-write failure is logged but
  // never fails a request whose actual data write already succeeded."
  const cleanupCommandCount = cmds.length;
  cmds.push(["LPUSH", ADMIN_AUDIT_KEY, audit]);
  cmds.push(["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1]);

  // `upstashPipeline` reports a per-command failure in the RESULT, it does not
  // throw (AGENTS.md). Unchecked, the category script refusing an over-cap
  // union — or any other command failing — would return a cheerful seed count
  // for a seed that did not fully happen. The route turns this into a 503.
  const results = await upstashPipeline(cmds);
  const failed = results.slice(0, cleanupCommandCount).find((r) => r.error);
  if (failed) throw new Error(`Seed failed: ${failed.error}`);
  const auditFailed = results.slice(cleanupCommandCount).find((r) => r.error);
  if (auditFailed) console.error("[admin] seed audit write failed:", errorLabel(new Error(auditFailed.error)));
  // #186: the forensics challenges' artifacts, through the attachments store
  // (so the caps and locks apply). Keyed by sha256 — a re-seed adds nothing.
  if (classicEnabled) {
    // After the seed landed: a failure here is logged, like the audit write
    // above — the demo is seeded, only its forensics files are not.
    await seedDemoAttachments().catch((err) => console.error("[admin] demo attachments failed:", errorLabel(err)));
  }
  return {
    contestants: DEMO_CONTESTANTS.length,
    teams: DEMO_TEAMS.length,
    solves: total,
    sponsors: DEMO_SPONSORS.length,
  };
}

/**
 * The inverse of `seedDemoData`, for the same DEMO_MODE-free "dangerous
 * setting" surface (issue #419) — admin-gated + type-to-confirm at the
 * route, same as `resetEvent`. No live-event guard, also matching
 * `resetEvent`: an admin who explicitly typed the confirmation phrase is
 * trusted the same way here as there.
 *
 * Deliberately narrower than seeding's write set: it removes exactly the
 * RUN-STATE rows seeding fabricates (fake solves/attempts, the aggregate
 * points/solved/answered hashes, the demo teams and the membership fields
 * stamped onto their members, the demo sponsors) but leaves the demo
 * quiz/classic/ai QUESTIONS, CHALLENGES, FLAGS and CATEGORIES alone. That
 * mirrors `resetEvent`'s own philosophy one section up: once written, a
 * challenge record is authored content, not run state, and this function
 * has no more business deleting it unprompted than a master reset does —
 * remove it by hand from the module's admin tab, same as the category-union
 * caveat above already tells an organizer to do. (Solvecount is similarly
 * left alone: `raiseSolveCounts` raises it to a FLOOR, not an additive
 * total, so there is no well-defined amount to subtract back out.)
 *
 * Removal is by EXACT fixture id/login match (`HDEL`/`DEL` on the specific
 * keys and fields `seedDemoData` writes) — not a scan, not a full wipe. If
 * an organizer has since created real content that happens to reuse one of
 * the fixture's ids or its fake logins (e.g. a real login literally spelled
 * "neo-anderson"), this removes that too. Accepted collision risk, same
 * class seeding already carries going the other direction — not new, just
 * the inverse.
 */
export async function clearDemoData(actor: string): Promise<{ contestants: number; teams: number; sponsors: number }> {
  const now = Date.now();
  const cmds: (string | number)[][] = [];

  // Secure-development fake solves — not gated on the module being enabled
  // NOW, unlike seeding: these rows may have been written under a different
  // module set, and an HDEL on a field that was never there is a no-op.
  for (const c of DEMO_CONTESTANTS) {
    for (const [target, ids] of Object.entries(c.solves)) {
      for (const id of ids) cmds.push(["HDEL", `ctf:solves:${target}`, `${c.login}:${id}`]);
    }
  }

  // Teams, their member sets, and the membership fields seeding stamped onto
  // each member's user hash (issue #169 / ADR 49) — never the whole user
  // hash, which may carry fields this action didn't write.
  for (const t of DEMO_TEAMS) {
    cmds.push(["DEL", `ctf:team:${t.slug}`]);
    cmds.push(["DEL", `ctf:team:${t.slug}:members`]);
    for (const m of t.members) cmds.push(["HDEL", `ctf:user:${m}`, "team", "joinedAt", "firstTeamAt"]);
  }

  // Per-login solve/attempt/aggregate rows for all three content modules,
  // same "attempt regardless of what's live now" reasoning as the
  // secure-development block above.
  for (const c of DEMO_CONTESTANTS) {
    cmds.push(["DEL", quizAnswersKey(c.login)]);
    cmds.push(["DEL", quizAttemptsKey(c.login)]);
    cmds.push(["HDEL", QUIZ_POINTS_KEY, c.login]);
    cmds.push(["HDEL", QUIZ_ANSWERED_KEY, c.login]);
    cmds.push(["HDEL", QUIZ_LAST_AT_KEY, c.login]);

    cmds.push(["DEL", classicSolvesKey(c.login)]);
    cmds.push(["DEL", classicAttemptsKey(c.login)]);
    cmds.push(["HDEL", CLASSIC_POINTS_KEY, c.login]);
    cmds.push(["HDEL", CLASSIC_SOLVED_KEY, c.login]);
    cmds.push(["HDEL", CLASSIC_LAST_AT_KEY, c.login]);

    cmds.push(["DEL", aiSolvesKey(c.login)]);
    cmds.push(["DEL", aiAttemptsKey(c.login)]);
    cmds.push(["HDEL", AI_POINTS_KEY, c.login]);
    cmds.push(["HDEL", AI_SOLVED_KEY, c.login]);
    cmds.push(["HDEL", AI_LAST_AT_KEY, c.login]);
  }

  // Sponsors — same platform-wide, never-module-gated reasoning seeding uses.
  for (const s of DEMO_SPONSORS) {
    cmds.push(["HDEL", SPONSORS_KEY, s.id]);
    cmds.push(["HDEL", SPONSORS_LOGO_KEY, s.id]);
  }

  const audit = JSON.stringify({
    at: new Date(now).toISOString(),
    by: actor,
    action: "clear-demo",
    contestants: DEMO_CONTESTANTS.length,
    teams: DEMO_TEAMS.length,
    sponsors: DEMO_SPONSORS.length,
  });
  // Tracked BEFORE the two audit commands below — same reasoning as
  // seedDemoData's own pipeline check: an audit-write failure must never
  // mask (or falsely trigger) a report on whether the actual clear
  // succeeded (writeAdminAudit's own doc comment states the rule).
  const cleanupCommandCount = cmds.length;
  cmds.push(["LPUSH", ADMIN_AUDIT_KEY, audit]);
  cmds.push(["LTRIM", ADMIN_AUDIT_KEY, 0, AUDIT_CAP - 1]);

  // Same reasoning as seedDemoData's own pipeline check: a per-command
  // failure doesn't throw on its own (AGENTS.md), so an unchecked call would
  // report a cheerful "cleared" count for a clear that only partly happened.
  // The demo rows' points are about to leave the board (#553): a
  // score-lowering bracket (fold-cache.ts) around the pipeline — the shared
  // in-progress marker up and the revision bumped BEFORE it, so a hint
  // charge on any app task is refused meanwhile and a fold that read those
  // points finds its revision moved; closed in the finally AFTER it, including
  // when a command failed while its neighbours ran. `begin` throws if the
  // marker cannot be set, and nothing is cleared in that state.
  await beginScoreLowering();
  let results: Awaited<ReturnType<typeof upstashPipeline>>;
  try {
    results = await upstashPipeline(cmds);
  } finally {
    await endScoreLowering();
  }
  const failed = results.slice(0, cleanupCommandCount).find((r) => r.error);
  if (failed) throw new Error(`Clear demo data failed: ${failed.error}`);
  const auditFailed = results.slice(cleanupCommandCount).find((r) => r.error);
  if (auditFailed) console.error("[admin] clear-demo audit write failed:", errorLabel(new Error(auditFailed.error)));
  return { contestants: DEMO_CONTESTANTS.length, teams: DEMO_TEAMS.length, sponsors: DEMO_SPONSORS.length };
}
