import "server-only";
import { assertPipelineOk, parseScanPage, upstashPipeline, type UpstashResult } from "@/lib/upstash";
import { userKey, userHintTimesKey, HINTS_SPENT_KEY } from "@/lib/team-keys";
import { QUIZ_POINTS_KEY, QUIZ_QUESTIONS_KEY, quizAnswersKey, quizAttemptsKey } from "@/lib/quiz-keys";
import { CLASSIC_CHALLENGES_KEY, CLASSIC_POINTS_KEY, classicAttemptsKey, classicSolvesKey } from "@/lib/classic-keys";
import { AI_CHALLENGES_KEY, AI_POINTS_KEY, aiAttemptsKey, aiSolvesKey } from "@/lib/ai-keys";
import { listTeams } from "@/lib/team-store";
import { parseAttemptRow } from "@/lib/attempt-row";
import { getLeaderboardSource, getLeaderboardSourceMode } from "@/lib/leaderboard/source";
import { errorLabel } from "@/lib/error-label";

/**
 * Event engagement metrics (issue #169), computed ENTIRELY from data the box
 * already stores.
 *
 * There is no collection step and no new write path. Every number below is a
 * read over keys the modules already maintain: quiz answers and classic solves
 * carry `{points, at}` per item per login, Secure Development solves are
 * timestamped in `ctf:solves:<target>`, attempts are counted per login, and
 * `firstTeamAt` (ADR 49) supplies the funnel's conversion moment.
 *
 * The one figure that is not a Redis key of this app's own: Secure
 * Development POINTS. `ctf:solves:*` says who solved what and when, never for
 * how much — points are a rubric property the scorer applies — so the
 * per-login SD total is read from the leaderboard source (the scorer's own
 * `GET /leaderboard`, or its ZSET), whose `entry.points` is exactly that
 * number before the module overlays add theirs (module-contributions.ts).
 * Issue #432: without it every team here read lower than the board by
 * precisely its SD points, under a caveat promising SD was counted.
 *
 * WHY NOT COLLECT FROM FORKS. A fork could report far more — pages opened,
 * time on a challenge, when someone gave up. It cannot report it *credibly*.
 * Authenticating a fork means a credential every contestant can read, so any
 * ingest endpoint is forgeable by every contestant, and engagement numbers
 * that a participant can inflate are worse than numbers that are merely
 * incomplete. ADR 46's rule for `/api/public/scoring` is the read-side of the
 * same boundary: that endpoint is read-only and policy-only, and metrics does
 * not touch it in either direction.
 *
 * COST. This is O(contestants) in round trips, batched. It is an on-demand
 * admin read — one per click, not one per page view — and deliberately not
 * cached, because an organizer refreshing it mid-event wants the current
 * number, not one from a minute ago.
 */

/** Solves-over-time bucket width. Ten minutes is the resolution at which a
 *  room going quiet is visible without the series becoming noise. */
const BUCKET_MS = 10 * 60 * 1000;

/** Hard ceiling on contestants folded in one pass. An event this size is far
 *  beyond what the kit targets; the cap exists so a runaway key space cannot
 *  turn an admin click into an unbounded read. Reported in `caveats` when it
 *  bites, because a silently truncated metric reads as a complete one. */
const MAX_CONTESTANTS = 2000;

/** Commands per pipeline round trip. */
const BATCH = 200;

export type ChallengeStat = {
  module: "quiz" | "classic" | "ai";
  id: string;
  /** What the organizer called it — a challenge's title, a question's prompt.
   *  `null` when the catalogue no longer holds it (a challenge deleted after
   *  it was solved still has metrics) or when the catalogue read failed; the
   *  id is always there to fall back on. See `readTitles` (audit F7). */
  title: string | null;
  /** Distinct contestants who earned it. */
  solves: number;
  /** Total submissions against it, successful or not. */
  attempts: number;
  /** solves / distinct people who tried it, or null when nobody did.
   *  Never exceeds 1: see the denominator note in the fold. */
  solveRate: number | null;
  /** Mean attempts taken by the contestants who did earn it. The real
   *  difficulty signal — a challenge solved by everyone on the fourth try is
   *  harder than its solve rate suggests. */
  avgAttemptsToSolve: number | null;
  /** Median seconds from a contestant's FIRST attempt at this item to earning
   *  it. Median, not mean: one contestant who left a tab open overnight would
   *  otherwise dominate the figure. Null until enough rows carry `firstAt`. */
  medianSecondsToSolve: number | null;
  /** Contestants who bought this item's hint before earning it. Classic and
   *  ai are per-challenge contributors here (#190, and its ai counterpart);
   *  quiz has no hints by design, so this is always 0 there. */
  solvedAfterHint: number;
};

export type EventMetrics = {
  generatedAt: string;
  funnel: {
    /** Distinct logins on a team right now. */
    onATeam: number;
    /** Distinct logins that have EVER been on a team — the conversion count,
     *  which survives leaving and switching (ADR 49). */
    everOnATeam: number;
    /** Made at least one submission in any module. */
    attempted: number;
    /** Earned at least one point-bearing item in any module. */
    scored: number;
    /** Attempted and never scored — the contestants who got stuck. */
    stuck: number;
  };
  challenges: ChallengeStat[];
  /** Solves per 10-minute bucket, ascending. Quiz, classic and ai only; see caveats. */
  timeline: { at: string; solves: number }[];
  teams: { slug: string; name: string; size: number; points: number }[];
  modules: { quiz: number; classic: number; ai: number; secureDevelopment: number };
  hints: {
    buyers: number;
    totalSpend: number;
    /** Hints bought BEFORE the buyer solved the thing, over hints bought at
     *  all. A hint bought afterwards bought nothing; separating the two is the
     *  difference between "hints are used" and "hints help". */
    boughtBeforeSolving: number;
    boughtAfterSolving: number;
  };
  /** What these numbers do NOT measure, in the payload rather than only in the
   *  docs — a metric whose limits travel separately from it gets quoted
   *  without them. */
  caveats: string[];
};

type Earned = { points: number; at: string };

function parseEarned(raw: unknown): Earned | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.points !== "number" || typeof v.at !== "string") return null;
    return { points: v.points, at: v.at };
  } catch {
    return null;
  }
}

/** Median, not mean, for durations: one contestant who left a tab open
 *  overnight would otherwise dominate a per-challenge figure computed from a
 *  handful of solvers. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Upstash returns a hash as a flat [field, value, ...] array. */
function hashEntries(result: unknown): [string, unknown][] {
  if (!Array.isArray(result)) return [];
  const out: [string, unknown][] = [];
  for (let i = 0; i + 1 < result.length; i += 2) out.push([String(result[i]), result[i + 1]]);
  return out;
}

// Returns UpstashResult, not `{ result?: unknown }`: the narrower type erased
// the `error` field, so a caller checking it would be reading a property
// TypeScript believed could never be set (issue #358).
async function batched(commands: (string | number)[][]): Promise<UpstashResult[]> {
  const out: UpstashResult[] = [];
  for (let i = 0; i < commands.length; i += BATCH) {
    out.push(...(await upstashPipeline(commands.slice(i, i + BATCH))));
  }
  return out;
}

/**
 * Every Secure Development solve, as `<target>/<login>/<challengeId>` -> ISO.
 *
 * The TARGET is kept in the key, not flattened away. Challenge ids are unique
 * within an app's catalogue but nothing makes them unique ACROSS apps, so a
 * hint bought on one target could otherwise be matched against a solve on
 * another that happens to share an id.
 */
async function readSecureDevSolves(): Promise<Map<string, string>> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [scan] = await upstashPipeline([["SCAN", cursor, "MATCH", "ctf:solves:*", "COUNT", 1000]]);
    // Throws rather than ending the walk on a failed page (issue #358). An
    // undercount presented as a measurement is worse than a failed one, and
    // this module already has a way to say so — see the caller's caveats.
    const [next, found] = parseScanPage(scan, "metrics secure-dev solves");
    cursor = next;
    keys.push(...found);
  } while (cursor !== "0");
  const out = new Map<string, string>();
  if (!keys.length) return out;
  // Checked, like the SCAN above (issue #358): a failed HGETALL reads as an
  // empty hash, so the target's solves vanish from every figure computed
  // from this map — silently, and the caller has a caveat for exactly this.
  const replies = assertPipelineOk(
    await batched(keys.map((k) => ["HGETALL", k])),
    "metrics secure-dev solves",
  );
  keys.forEach((key, i) => {
    const target = key.slice("ctf:solves:".length);
    for (const [field, at] of hashEntries(replies[i]?.result)) {
      // field is `<login>:<challengeId>`
      const sep = field.indexOf(":");
      if (sep <= 0) continue;
      out.set(`${target}/${field.slice(0, sep).toLowerCase()}/${field.slice(sep + 1)}`, String(at));
    }
  });
  return out;
}

/**
 * `<module>:<id>` -> the name an organizer would recognise, read from the
 * three catalogue hashes (audit F7).
 *
 * The metrics fold works entirely in ids, because ids are what contestant
 * progress is recorded against. That is right for the arithmetic and wrong for
 * the reader: `case-probe-control-xf1ob0` means nothing said out loud at a
 * closing ceremony, while the quiz and challenge lists two tabs away have
 * shown titles all along.
 *
 * Quiz questions carry a `prompt` rather than a `title`; classic and ai carry
 * `title`. Both are read here so the caller never has to know which.
 *
 * Deliberately best-effort, and that has to be enforced here rather than
 * assumed: `upstashPipeline` THROWS on a timeout, a missing URL/token or a
 * non-2xx response (it is only per-command errors it returns as values), so an
 * uncaught call would reject `computeEventMetrics` and a failure to fetch
 * LABELS would cost the organizer every NUMBER on the tab. The whole request
 * is therefore caught and degrades to an empty map: rows keep their ids, which
 * is the same thing that happens for a challenge deleted after it was solved.
 */
async function readTitles(): Promise<Map<string, string>> {
  let replies: { result?: unknown }[];
  try {
    replies = await upstashPipeline([
      ["HGETALL", QUIZ_QUESTIONS_KEY],
      ["HGETALL", CLASSIC_CHALLENGES_KEY],
      ["HGETALL", AI_CHALLENGES_KEY],
    ]);
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  (["quiz", "classic", "ai"] as const).forEach((module, i) => {
    for (const [id, raw] of hashEntries(replies[i]?.result)) {
      try {
        const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== "object") continue;
        const record = parsed as { title?: unknown; prompt?: unknown };
        const name = typeof record.title === "string" ? record.title : record.prompt;
        if (typeof name === "string" && name.trim()) out.set(`${module}:${id}`, name.trim());
      } catch {
        // One unparseable row costs that row its title, never the others'.
      }
    }
  });
  return out;
}

export async function computeEventMetrics(): Promise<EventMetrics> {
  const caveats: string[] = [];

  const teams = await listTeams();
  const onATeam = new Set<string>();
  for (const t of teams) for (const m of t.members) onATeam.add(m.toLowerCase());

  // Only the point totals and the hint spend are read as aggregates. The
  // per-challenge counts deliberately are NOT: `ctf:classic:solvecount` would
  // be a free classic-only shortcut, but folding each contestant's own solve
  // rows produces the same figure for EVERY module from one source. Reading
  // both would invite the two to disagree and leave no way to tell which was
  // right.
  const [quizPointsRes, classicPointsRes, aiPointsRes, hintsSpentRes] = await upstashPipeline([
    ["HGETALL", QUIZ_POINTS_KEY],
    ["HGETALL", CLASSIC_POINTS_KEY],
    ["HGETALL", AI_POINTS_KEY],
    ["HGETALL", HINTS_SPENT_KEY],
  ]);

  const quizPoints = new Map(hashEntries(quizPointsRes.result).map(([k, v]) => [k.toLowerCase(), Number(v) || 0]));
  const classicPoints = new Map(
    hashEntries(classicPointsRes.result).map(([k, v]) => [k.toLowerCase(), Number(v) || 0]),
  );
  const aiPoints = new Map(hashEntries(aiPointsRes.result).map(([k, v]) => [k.toLowerCase(), Number(v) || 0]));
  const hintsSpent = hashEntries(hintsSpentRes.result).map(([k, v]) => [k.toLowerCase(), Number(v) || 0] as const);

  // Secure Development points per login (issue #432), from the leaderboard
  // source — see the file header for why no Redis key of ours holds them.
  // Gated on the source MODE, not just on whether a fetch works:
  //   - "empty" is the source's own answer when the module is off; there is
  //     nothing to read and nothing to say.
  //   - "mock" is placeholder data the board shows behind an amber banner.
  //     Folding it in here would put invented points on a screen with no
  //     banner, so it is left out and the reason is printed instead.
  // The fail direction matches the solves sweep below: a scorer that cannot
  // be reached costs the SD share of the totals and SAYS so, never the panel.
  const sdPoints = new Map<string, number>();
  const sourceMode = await getLeaderboardSourceMode();
  if (sourceMode === "mock") {
    caveats.push(
      'LEADERBOARD_SOURCE is "mock" — the board\'s Secure Development scores are placeholder data, so they are left out of the team points below.',
    );
  } else if (sourceMode !== "empty") {
    try {
      const data = await (await getLeaderboardSource()).getLeaderboard();
      for (const entry of data.entries) {
        const points = Number(entry.points);
        if (Number.isFinite(points)) sdPoints.set(entry.login.toLowerCase(), points);
      }
    } catch (err) {
      console.error("secure-development points unavailable for metrics:", errorLabel(err));
      caveats.push(
        "Secure Development points could not be read — team points below hold Quiz, Jeopardy and AI points only.",
      );
    }
  }

  // A SCAN page that cannot be read now throws (issue #358) instead of
  // silently truncating the walk. Caught here rather than failing the whole
  // panel: every other figure on it is still valid, and this module's own
  // convention is to SAY a number is short rather than quietly present it.
  // Without the caveat the counts would look authoritative while omitting
  // however many contestants sat on the unread pages.
  let sdSolves: Map<string, string>;
  try {
    sdSolves = await readSecureDevSolves();
  } catch (err) {
    console.error("secure-development solves unavailable for metrics:", errorLabel(err));
    // Names the hint-order counts too, not just the obvious ones: the
    // per-slot `solvedAt` lookup below reads this same map, so a Secure
    // Development hint slot with no solve time contributes to NEITHER
    // boughtBeforeSolving nor boughtAfterSolving. Those two would otherwise
    // look complete while quietly omitting a module.
    caveats.push(
      "Secure Development solves could not be read — participation, funnel, solve and hint-order counts below are incomplete.",
    );
    sdSolves = new Map();
  }
  const sdLogins = new Set<string>();
  for (const composite of sdSolves.keys()) {
    const parts = composite.split("/");
    if (parts.length >= 2) sdLogins.add(parts[1]);
  }

  // The contestant set: anyone on a team, anyone who has scored in any module.
  // Cheaper than SCANning `ctf:user:*`, which also matches
  // `ctf:user:<login>:hints` and would need filtering.
  //
  // TEAM MEMBERSHIP IS WHAT FINDS THE STUCK. Someone who attempted everything
  // and solved nothing has no points row, so the aggregate keys do not know
  // they exist — only their team does. That is sound because ADR 47 makes a
  // team mandatory before anything scores, which is exactly why `stuck` is
  // measurable at all. An event running with TEAM_WRITES_ENABLED unset has no
  // real teams, and would see only contestants who scored.
  const contestants = new Set<string>([
    ...onATeam,
    ...quizPoints.keys(),
    ...classicPoints.keys(),
    ...aiPoints.keys(),
    ...sdLogins,
    ...sdPoints.keys(),
  ]);
  let logins = [...contestants].sort();
  if (logins.length > MAX_CONTESTANTS) {
    caveats.push(
      `Only the first ${MAX_CONTESTANTS} of ${logins.length} contestants were folded in — every figure below undercounts.`,
    );
    logins = logins.slice(0, MAX_CONTESTANTS);
  }

  // Eight reads per contestant: their earned items (quiz, classic, ai), their
  // attempt rows (quiz, classic, ai), the firstTeamAt that anchors the funnel,
  // and when they bought each hint.
  const PER_LOGIN = 8;
  const perLogin = await batched(
    logins.flatMap((l) => [
      ["HGETALL", quizAnswersKey(l)],
      ["HGETALL", classicSolvesKey(l)],
      ["HGETALL", aiSolvesKey(l)],
      ["HGETALL", quizAttemptsKey(l)],
      ["HGETALL", classicAttemptsKey(l)],
      ["HGETALL", aiAttemptsKey(l)],
      ["HMGET", userKey(l), "firstTeamAt"],
      ["HGETALL", userHintTimesKey(l)],
    ]),
  );

  let everOnATeam = 0;
  let attempted = 0;
  let scored = 0;
  let hintsBeforeSolve = 0;
  let hintsAfterSolve = 0;
  const buckets = new Map<number, number>();
  const solvesById = new Map<
    string,
    { module: "quiz" | "classic" | "ai"; solvers: number; attemptSum: number; durations: number[] }
  >();
  const attemptsById = new Map<
    string,
    { module: "quiz" | "classic" | "ai"; attempts: number; attempters: number }
  >();
  // Per-challenge "solved after buying its hint" counts, keyed like
  // solvesById (`classic:<id>` or `ai:<id>`) — fed by the hint-timing loop
  // below (#190).
  const hintHelpedById = new Map<string, number>();
  const pointsByLogin = new Map<string, number>();

  logins.forEach((login, i) => {
    const quizAnswers = hashEntries(perLogin[i * PER_LOGIN]?.result);
    const classicSolves = hashEntries(perLogin[i * PER_LOGIN + 1]?.result);
    const aiSolves = hashEntries(perLogin[i * PER_LOGIN + 2]?.result);
    const quizAttempts = hashEntries(perLogin[i * PER_LOGIN + 3]?.result);
    const classicAttempts = hashEntries(perLogin[i * PER_LOGIN + 4]?.result);
    const aiAttempts = hashEntries(perLogin[i * PER_LOGIN + 5]?.result);
    const userFields = perLogin[i * PER_LOGIN + 6]?.result;
    const firstTeamAt = Array.isArray(userFields) ? userFields[0] : null;
    const hintTimes = hashEntries(perLogin[i * PER_LOGIN + 7]?.result);

    // Did the hint arrive in time to help? A hint bought AFTER the solve
    // bought nothing, and counting the two together turns "hints are used"
    // into a claim that "hints help" — which the data would not support.
    // Secure-development slots compare against the scorer's solve times;
    // classic and ai slots (#190, and ai's own hints) against this login's
    // own solve rows, already loaded above. The target stays in the key so
    // two targets sharing a challenge id cannot cross-match.
    for (const [slot, boughtAt] of hintTimes) {
      const slash = String(slot).indexOf("/");
      if (slash <= 0) continue;
      const target = String(slot).slice(0, slash);
      const challengeId = String(slot).slice(slash + 1);
      let solvedAt: string | undefined;
      if (target === "classic") {
        const row = classicSolves.find(([cid]) => cid === challengeId);
        solvedAt = row ? parseEarned(row[1])?.at : undefined;
      } else if (target === "ai") {
        const row = aiSolves.find(([cid]) => cid === challengeId);
        solvedAt = row ? parseEarned(row[1])?.at : undefined;
      } else {
        solvedAt = sdSolves.get(`${target}/${login}/${challengeId}`);
      }
      if (!solvedAt) continue; // bought, never solved — neither before nor after
      const boughtMs = Date.parse(String(boughtAt));
      const solvedMs = Date.parse(solvedAt);
      if (Number.isNaN(boughtMs) || Number.isNaN(solvedMs)) continue;
      if (boughtMs <= solvedMs) {
        hintsBeforeSolve += 1;
        if (target === "classic" || target === "ai") {
          const key = `${target}:${challengeId}`;
          hintHelpedById.set(key, (hintHelpedById.get(key) ?? 0) + 1);
        }
      } else {
        hintsAfterSolve += 1;
      }
    }

    if (typeof firstTeamAt === "string" && firstTeamAt) everOnATeam += 1;

    const hasAttempt = quizAttempts.length > 0 || classicAttempts.length > 0 || aiAttempts.length > 0;
    const earnedRows: [("quiz" | "classic" | "ai"), [string, unknown][]][] = [
      ["quiz", quizAnswers],
      ["classic", classicSolves],
      ["ai", aiSolves],
    ];
    // Secure Development counts as earned on EITHER record of it: a solve row
    // in ctf:solves:*, or points on the leaderboard source. The two are
    // written by different processes (the poller and the scorer) and can
    // disagree for a login — a solves sweep that failed a page, an entry the
    // scorer knows that the poller has not stored — and a contestant whose
    // points are in the team total below must not read as never having
    // scored in the funnel above it.
    const hasEarned =
      earnedRows.some(([, rows]) => rows.length > 0) || sdLogins.has(login) || (sdPoints.get(login) ?? 0) > 0;

    if (hasAttempt || hasEarned) attempted += 1;
    if (hasEarned) scored += 1;

    // Every module the funnel above counts as scoring, including Secure
    // Development (issue #432) — `hasEarned` and this sum must agree on what
    // a point is, or a team of SD-only solvers reads as "scored" with 0.
    // Gross points throughout: the module hashes hold pre-penalty totals and
    // so does the source's `points`, so hint penalties are not applied here
    // any more than they are to the other three.
    pointsByLogin.set(
      login,
      (quizPoints.get(login) ?? 0) +
        (classicPoints.get(login) ?? 0) +
        (aiPoints.get(login) ?? 0) +
        (sdPoints.get(login) ?? 0),
    );

    for (const [mod, rows] of earnedRows) {
      for (const [id, raw] of rows) {
        const earned = parseEarned(raw);
        if (!earned) continue;
        const ms = Date.parse(earned.at);
        if (!Number.isNaN(ms)) {
          const bucket = Math.floor(ms / BUCKET_MS) * BUCKET_MS;
          buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        }
        const key = `${mod}:${id}`;
        const stat = solvesById.get(key) ?? { module: mod, solvers: 0, attemptSum: 0, durations: [] as number[] };
        stat.solvers += 1;
        // How many tries THIS contestant took to earn it, and how long it took
        // them. The attempt row survives the solve, so both are available
        // after the fact — `firstAt` (issue #169) is what makes the duration
        // knowable at all; before it, only the LAST attempt had a time.
        const attemptRow = (mod === "quiz" ? quizAttempts : mod === "classic" ? classicAttempts : aiAttempts).find(
          ([aid]) => aid === id,
        );
        const parsed = parseAttemptRow(attemptRow?.[1]);
        stat.attemptSum += Math.max(1, parsed.attempts);
        if (parsed.firstAt && !Number.isNaN(ms)) {
          const startedMs = Date.parse(parsed.firstAt);
          // Guard the ordering: a solve recorded before its first attempt is
          // corrupt data, and a negative duration would drag the median.
          if (!Number.isNaN(startedMs) && ms >= startedMs) {
            stat.durations.push(Math.round((ms - startedMs) / 1000));
          }
        }
        solvesById.set(key, stat);
      }
    }

    for (const [mod, rows] of [
      ["quiz", quizAttempts],
      ["classic", classicAttempts],
      ["ai", aiAttempts],
    ] as const) {
      for (const [id, raw] of rows) {
        const key = `${mod}:${id}`;
        const stat = attemptsById.get(key) ?? { module: mod, attempts: 0, attempters: 0 };
        stat.attempts += parseAttemptRow(raw).attempts;
        stat.attempters += 1;
        attemptsById.set(key, stat);
      }
    }
  });

  const titles = await readTitles();
  const challenges: ChallengeStat[] = [...new Set([...solvesById.keys(), ...attemptsById.keys()])]
    .map((key) => {
      const solved = solvesById.get(key);
      const tried = attemptsById.get(key);
      const [mod, ...rest] = key.split(":");
      const solves = solved?.solvers ?? 0;
      // The denominator is everyone who TRIED, and a solver necessarily tried
      // even when no attempt row records it — earned rows can exist without
      // one, because the demo seed writes answers directly and any data
      // predating the attempt hash has the same shape. Dividing by the
      // attempt-row count alone produced solve rates of 200% and 300% on a
      // seeded event, which is nonsense on its face rather than a subtle
      // inaccuracy. `attempters` can never legitimately be below `solves`, so
      // taking the larger of the two is both the correct denominator and a
      // floor that keeps the rate inside 0..1.
      const triers = Math.max(tried?.attempters ?? 0, solves);
      return {
        module: mod as "quiz" | "classic" | "ai",
        id: rest.join(":"),
        title: titles.get(key) ?? null,
        solves,
        attempts: tried?.attempts ?? 0,
        solveRate: triers > 0 ? solves / triers : null,
        avgAttemptsToSolve: solves > 0 ? (solved as { attemptSum: number }).attemptSum / solves : null,
        medianSecondsToSolve: median(solved?.durations ?? []),
        solvedAfterHint: hintHelpedById.get(key) ?? 0, // classic + ai per-challenge (#190); quiz has no hints
      };
    })
    .sort((a, b) => a.solves - b.solves || a.id.localeCompare(b.id));

  const timeline = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ms, solves]) => ({ at: new Date(ms).toISOString(), solves }));

  const teamRows = teams
    .map((t) => ({
      slug: t.slug,
      name: t.name,
      size: t.members.length,
      // The team's own leaderboard total is a UNION fold over its members'
      // items; summing per-login aggregates would double count a challenge two
      // teammates both solved. This is a rough per-team sum and is labelled as
      // such, not presented as the leaderboard figure.
      points: t.members.reduce((sum, m) => sum + (pointsByLogin.get(m.toLowerCase()) ?? 0), 0),
    }))
    .sort((a, b) => b.points - a.points);

  caveats.push(
    "Team points here SUM each member's own totals; the leaderboard folds the UNION of their solves, so a challenge two teammates both solved counts once there and twice here.",
    "The timeline plots solves, not submissions: attempt rows carry a first and a last time but not one per try.",
    "Time-to-solve and hint ordering are blank for anything earned before those timestamps were added, so early-event figures cover fewer contestants than late-event ones.",
    "Signing in leaves no record; the funnel starts at 'ever on a team'.",
    "Secure Development items have no per-challenge attempt data — its scores arrive from GitHub already judged, so it contributes to participation and points only.",
  );

  return {
    generatedAt: new Date().toISOString(),
    funnel: {
      onATeam: onATeam.size,
      everOnATeam,
      attempted,
      scored,
      stuck: Math.max(0, attempted - scored),
    },
    challenges,
    timeline,
    teams: teamRows,
    modules: {
      quiz: [...quizPoints.values()].filter((p) => p > 0).length,
      classic: [...classicPoints.values()].filter((p) => p > 0).length,
      ai: [...aiPoints.values()].filter((p) => p > 0).length,
      secureDevelopment: sdLogins.size,
    },
    hints: {
      buyers: hintsSpent.filter(([, spent]) => spent > 0).length,
      totalSpend: hintsSpent.reduce((sum, [, spent]) => sum + spent, 0),
      boughtBeforeSolving: hintsBeforeSolve,
      boughtAfterSolving: hintsAfterSolve,
    },
    caveats,
  };
}

/** CSV of the per-challenge table — the sheet an organizer actually wants
 *  after an event. Deliberately the challenge table and not the whole payload:
 *  the funnel is five numbers that belong on screen, and a CSV of nested
 *  objects is a CSV nobody opens twice. */
export function challengesToCsv(metrics: EventMetrics): string {
  const esc = (v: string | number | null) => {
    if (v === null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    // `title` sits beside `id`, never instead of it: the id is what a support
    // question or a store key names, and a title can be blank for a challenge
    // deleted since it was solved (audit F7).
    ["module", "id", "title", "solves", "attempts", "solve_rate", "avg_attempts_to_solve", "median_seconds_to_solve"],
    ...metrics.challenges.map((c) => [
      c.module,
      c.id,
      c.title,
      c.solves,
      c.attempts,
      c.solveRate === null ? null : c.solveRate.toFixed(4),
      c.avgAttemptsToSolve === null ? null : c.avgAttemptsToSolve.toFixed(2),
      c.medianSecondsToSolve,
    ]),
  ];
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}
