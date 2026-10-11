import "server-only";
import { errorLabel } from "@/lib/error-label";
import { getAiTotals, getTeamAiTotalsBatch, listAiChallenges, type AiTotal } from "@/lib/ai-store";
import { atLeast, unionTotal, classicReachableDenominator, type Story } from "@/lib/leaderboard/denominators";
import {
  getClassicTotals,
  getTeamClassicTotalsBatch,
  listChallenges,
  listStories,
  type Challenge,
  type ClassicTotal,
} from "@/lib/classic-store";
import { getEnabledModuleIds, isModuleLive } from "@/lib/enabled-modules";
import { getEnabledTotals } from "@/lib/enabled-apps";
import { listTeams } from "@/lib/team-store";
import { getQuizTotals, getTeamQuizTotalsBatch, listQuestions, type QuizTotal } from "@/lib/quiz-store";
import { compareTeamStanding, rankByStanding } from "./rank";
import type { AppProgress, LeaderboardData, LeaderboardEntry, ModuleProgress, TeamStanding } from "./types";
import type { AppId } from "@/lib/apps";
import type { ModuleId } from "@/lib/modules";

/**
 * Builds each contestant row's per-module breakdown and re-ranks on the
 * combined result.
 *
 * The source's `points` already holds secure-development's score (it comes from
 * the scorer), so that module is ATTRIBUTED rather than added — adding it would
 * double count. The quiz, classic and ai modules score APP-SIDE: the scorer
 * never sees a quiz answer, a captured flag, or an ai challenge solve, so
 * their points are NOT already inside `entry.points` — they are ADDED on top
 * (`entry.points += quizPoints + classicPoints + aiPoints`). The two verbs
 * are not interchangeable in either direction: attributing an app-side
 * module would show zero, adding secure-development's would double count.
 *
 * Runs BEFORE withHintPenalties (see the pipeline comment in
 * `app/(site)/leaderboard/page.tsx`): every module block shows its GROSS
 * contribution, and the hint penalty nets the row's TOTAL exactly once, at
 * the end — the −N hints marker beside the header is what reconciles the
 * blocks against it. This re-ranks UNCONDITIONALLY; withHintPenalties
 * re-ranks again after deducting.
 *
 * Individuals read each app-side module's aggregate counters (`getQuizTotals`
 * / `getClassicTotals` / `getAiTotals` — two `HGETALL`s each, cost independent
 * of board size, mirroring `getHintPenalties`). Teams CANNOT: a team's total
 * is the UNION of the questions its members answered correctly (spec D6) /
 * the challenges they solved, and the aggregates have no memory of WHICH
 * items contributed to a login's total, so summing them would double count
 * anything two teammates both hold. Teams are handled by
 * `getTeamQuizTotalsBatch` / `getTeamClassicTotalsBatch` /
 * `getTeamAiTotalsBatch`, which read every member's item hash directly — all
 * of them in ONE pipeline for the whole board — and dedupe per team through
 * the shared fold in `team-fold.ts`; see its doc comment. Those batch reads
 * run in `withTeamQuizPoints` / `withTeamClassicPoints` / `withTeamAiPoints`
 * below, which `withTeamStandings` calls once over every team on the board —
 * this function itself stamps only the secure-development chip on a team, so
 * that each module reaches each team's total exactly once.
 *
 * The board's login set is the UNION of the source's logins and the logins
 * holding module points, so a contestant with quiz, classic or ai points but
 * no scored submission — every contestant on a quiz-only, classic-only or
 * ai-only event, where the source is `emptySource` and carries no rows at
 * all — gets a row CREATED for them here rather than being invisible until
 * their first scored PR. The union is taken case-insensitively (the scorer
 * records the PR author's login, the app-side modules the session's; a case
 * disagreement must not split one contestant into two rows), and a created
 * row is the only kind with no scoring entry behind it — so there is nothing
 * on it to double count, and every scorer-supplied field
 * (`patched`/`failed`/`total`/`apps`) stays zero-valued on it. A login
 * holding points in more than one app-side module gets ONE created row
 * carrying every block, never one row per module.
 *
 * Rows are only ever created from totals actually read: a failed
 * `getQuizTotals`/`getClassicTotals`/`getAiTotals` degrades to that module's
 * absence from the board, never to invented or zero-point rows.
 *
 * Hint penalties are applied by `withHintPenalties`, which runs AFTER this
 * (the pipeline's last stage), so created rows and synthesised team rows are
 * penalised like any other — the fix for hints being free on module-only
 * events.
 */
export async function withModuleContributions(data: LeaderboardData): Promise<LeaderboardData> {
  const liveModules = await getEnabledModuleIds();
  const secureDev = liveModules.has("secure-development") && data.capabilities.apps;
  const quizEnabled = liveModules.has("quiz");
  const classicEnabled = liveModules.has("classic");
  const aiEnabled = liveModules.has("ai");

  // Every enabled module's reads are KICKED OFF before any is awaited, so a
  // multi-module event overlaps them instead of paying for them back to back —
  // they hit disjoint key spaces and nothing orders one against another.
  // Each module still settles its OWN two reads independently; see below.
  const quizReads = quizEnabled ? Promise.allSettled([getQuizTotals(), listQuestions()]) : null;
  const classicReads = classicEnabled ? Promise.allSettled([getClassicTotals(), listChallenges(), listStories()]) : null;
  const aiReads = aiEnabled ? Promise.allSettled([getAiTotals(), listAiChallenges()]) : null;

  let quizTotals = new Map<string, QuizTotal>();
  let quizTotalQuestions = 0;
  if (quizReads) {
    // Settled INDEPENDENTLY, not under one shared `try`/`Promise.all`. The
    // two reads carry very different weight: `getQuizTotals` supplies the
    // POINTS (which change the board's totals and its ranking), while
    // `listQuestions` supplies only the "answered / total" DENOMINATOR. Under
    // a shared catch, a blip on the cosmetic read silently deleted everyone's
    // quiz points and re-ranked the board on wrong totals — while /profile,
    // which fetches totals on its own, still showed the real number. A failed
    // `listQuestions` must degrade to a missing denominator (clamped below),
    // never to lost points.
    const [totalsResult, questionsResult] = await quizReads;
    if (totalsResult.status === "fulfilled") {
      quizTotals = totalsResult.value;
    } else {
      // Degrade to the quiz-less view rather than failing the whole board —
      // same pattern as withHintPenalties/withTeamStandings.
      console.error("quiz totals unavailable for leaderboard:", errorLabel(totalsResult.reason));
    }
    if (questionsResult.status === "fulfilled") {
      quizTotalQuestions = questionsResult.value.length;
    } else {
      console.error("quiz question list unavailable for leaderboard denominator:", errorLabel(questionsResult.reason));
    }
  }

  let classicTotals = new Map<string, ClassicTotal>();
  let classicTotalChallenges = 0;
  // The catalogue, its ids and its story chains all come from the SAME
  // `listChallenges`/`listStories` replies that supply the count, so the
  // contestant path hands `classicModule` the same union and reachability
  // inputs the team path does — no second read of either. `classicLiveIds` is
  // undefined exactly when that read failed, which is `classicModule`'s cue to
  // fall back to the count.
  let classicChallenges: Challenge[] = [];
  let classicStories: Story[] = [];
  let classicLiveIds: ReadonlySet<string> | undefined;
  if (classicReads) {
    // Settled INDEPENDENTLY for exactly the reason spelled out above the quiz
    // pair, which this mirrors: `getClassicTotals` carries the POINTS and the
    // ranking they drive, `listChallenges` only the "solved / total"
    // DENOMINATOR. Never collapse these two into one shared try/Promise.all —
    // that is the shape that deletes everyone's points on a blip in a
    // purely cosmetic read.
    const [totalsResult, challengesResult, storiesResult] = await classicReads;
    if (totalsResult.status === "fulfilled") {
      classicTotals = totalsResult.value;
    } else {
      console.error("classic totals unavailable for leaderboard:", errorLabel(totalsResult.reason));
    }
    if (challengesResult.status === "fulfilled") {
      classicChallenges = challengesResult.value;
      classicTotalChallenges = challengesResult.value.length;
      classicLiveIds = new Set(challengesResult.value.map((c) => c.id));
    } else {
      console.error("classic challenge list unavailable for leaderboard denominator:", errorLabel(challengesResult.reason));
    }
    // Fail OPEN, the same direction `withTeamClassicPoints` takes: an unread
    // story list degrades to `[]`, which counts every live step as reachable
    // (nothing locked) — a blip must never lock a challenge behind a story
    // nobody could read.
    if (storiesResult.status === "fulfilled") {
      classicStories = storiesResult.value;
    } else {
      console.error("classic stories unavailable for leaderboard denominator:", errorLabel(storiesResult.reason));
    }
  }

  // Story-lock reachability for the CONTESTANT rows, keyed on the same
  // case-insensitively folded rule as the maps below. KICKED OFF here rather
  // than awaited, so its round trips overlap the ai reads; undefined whenever
  // there is no story to lock anything behind — the ordinary event pays no
  // extra read for this — and whenever the batched read could not settle, in
  // which case `classicModule` falls back to the clamp it always used rather
  // than inventing a locked step.
  const classicReachableRead =
    classicStories.length > 0 && classicChallenges.length > 0
      ? reachableByLogin(data, classicTotals, classicChallenges, classicStories)
      : Promise.resolve(undefined);

  let aiTotals = new Map<string, AiTotal>();
  let aiTotalChallenges = 0;
  if (aiReads) {
    // Settled INDEPENDENTLY for exactly the reason spelled out above the quiz
    // and classic pairs, which this mirrors: `getAiTotals` carries the
    // POINTS (and with them the team board's order), `listAiChallenges` only
    // the "solved / total" DENOMINATOR. Never collapse these two into one
    // shared try/Promise.all.
    const [totalsResult, challengesResult] = await aiReads;
    if (totalsResult.status === "fulfilled") {
      aiTotals = totalsResult.value;
    } else {
      console.error("ai totals unavailable for leaderboard:", errorLabel(totalsResult.reason));
    }
    if (challengesResult.status === "fulfilled") {
      aiTotalChallenges = challengesResult.value.length;
    } else {
      console.error("ai challenge list unavailable for leaderboard denominator:", errorLabel(challengesResult.reason));
    }
  }

  // Logins are matched case-insensitively throughout (see the doc comment).
  // Two keys in a totals map colliding on case cannot happen — a login is
  // unique case-insensitively on GitHub and every writer stores the one the
  // session reports — but the folds below are what make the lookup and the
  // union agree on a single rule either way.
  const quizByLogin = new Map<string, QuizTotal>();
  for (const [login, total] of quizTotals) quizByLogin.set(login.toLowerCase(), total);
  const classicByLogin = new Map<string, ClassicTotal>();
  for (const [login, total] of classicTotals) classicByLogin.set(login.toLowerCase(), total);
  const aiByLogin = new Map<string, AiTotal>();
  for (const [login, total] of aiTotals) aiByLogin.set(login.toLowerCase(), total);

  const classicReachable = await classicReachableRead;

  const overlay: Overlay = {
    quizByLogin,
    quizTotalQuestions,
    classicByLogin,
    classicTotalChallenges,
    classicLiveIds,
    classicReachable,
    aiByLogin,
    aiTotalChallenges,
  };

  const entries = rankByStanding([
    ...data.entries.map((entry) => attributeEntry(entry, secureDev, overlay)),
    ...createdEntries(
      data.entries,
      quizTotals,
      classicTotals,
      aiTotals,
      quizTotalQuestions,
      classicTotalChallenges,
      aiTotalChallenges,
      classicLiveIds,
      classicReachable,
    ),
  ]);

  // Teams get ONE thing from this stage: the secure-development chip. The
  // app-side modules (quiz, classic, ai) are attributed to teams in exactly
  // one place, `withTeamStandings`, which runs next and applies
  // `withTeamQuizPoints` / `withTeamClassicPoints` / `withTeamAiPoints` over
  // the UNION of the source's teams and the team store's, on rosters merged
  // from both records — which this stage does not have.
  let teams = data.teams;
  // secure-development is ATTRIBUTED for teams exactly as attributeEntry does
  // for entries: at this point team.points holds only the scorer's GROSS
  // score (the app-side modules are added by withTeamStandings, and hint
  // penalties net the total later, as the pipeline's last stage), so the
  // block's points are that number, not an addition — which is why it is
  // stamped HERE, before anything else lands in team.points.
  // Without this, an expanded team row showed QUIZ and CLASSIC point chips
  // while the secure-development share of the total appeared nowhere — a
  // captain adding up the chips came out short and read it as a scoring bug.
  if (secureDev && teams.length > 0) {
    teams = teams.map((team) => {
      const apps = team.apps;
      if (!apps || Object.keys(apps).length === 0) return team;
      const patched = Object.values(apps).reduce((n, app) => n + (app?.patched ?? 0), 0);
      // Same nothing-to-show gate as every other module block: a team that
      // hasn't scored here gets no chip, not a zero chip.
      if (patched === 0 && team.points === 0) return team;
      return {
        ...team,
        modules: {
          ...(team.modules ?? {}),
          "secure-development": secureDevelopmentModule(team.points, patched, team.lastSolveAt ?? null, apps),
        },
      };
    });
  }

  // The board-level denominator for a row's solved count: how many items this
  // EVENT has, across every enabled module. Stamped here because this is the
  // one place that already holds every module's count.
  //
  // Read off the EVENT, never off a row. A per-row denominator is the defect
  // that made /profile show "0 non-patched / 0 total" to a contestant who had
  // scored nothing — the number has to be what there is to do, not what that
  // contestant has touched.
  //
  // A failed `listQuestions`/`listChallenges` leaves its term at 0 (see the
  // independent-settle comments above), so this can come out SMALLER than
  // someone's solved count. The row clamps rather than rendering "28 / 21";
  // the clamp lives there because only a row knows its own numerator.
  const completable =
    (secureDev ? (await getEnabledTotals()).challenges : 0) + quizTotalQuestions + classicTotalChallenges + aiTotalChallenges;

  return { ...data, entries, teams, completable };
}

/** The app-side module totals for one render, threaded through the per-entry
 *  helpers below. Every `*ByLogin` map is keyed by LOWERCASED login — see the
 *  union rule in the doc comment. Each `*TotalX` count is that module's raw
 *  item total; the clamp against a row's own numerator happens per row, in
 *  `quizModule`/`classicModule`/`aiModule`. */
type Overlay = {
  quizByLogin: Map<string, QuizTotal>;
  quizTotalQuestions: number;
  classicByLogin: Map<string, ClassicTotal>;
  classicTotalChallenges: number;
  /** Live classic ids, undefined when that read failed — the union input
   *  `classicModule` shares with the team path. */
  classicLiveIds?: ReadonlySet<string>;
  /** Story-lock reachability per contestant row, keyed by LOWERCASED login
   *  and undefined when the event has no stories or the batched solves read
   *  failed — `classicModule` then clamps like it always did. */
  classicReachable?: ReadonlyMap<string, Reachable>;
  aiByLogin: Map<string, AiTotal>;
  aiTotalChallenges: number;
};

/** `{ total, max, locked }` exactly as `classicReachableDenominator` returns
 *  it — the story-lock answer for one row's solve set. */
type Reachable = { total: number; max: number; locked: number };

/** Every team's COMPLETE roster on this board, plus the login index those
 *  rosters imply.
 *
 *  The source's own teams and the team store's are two different records: the
 *  source knows the teams it SCORED, the store the teams contestants actually
 *  created. So a slug both records claim keeps the source's row and takes the
 *  UNION of the two rosters, and a team only the store knows is a team all the
 *  same — exactly the set `withTeamStandings` ranks, and exactly what a fold
 *  over membership has to see. Reading `data.teams` alone would take a partial
 *  roster for the whole team and leave a teammate's prerequisite solve out of
 *  the fold, re-locking a step the team has already earned.
 *
 *  `teamByLogin` is lowercased like every other login join in this codebase,
 *  with the TEAM STORE's attribution winning — the precedence
 *  `withTeamStandings` applies — so a row's team chip and its fold can never
 *  disagree. Pure over the already-fetched `storeTeams`: it reads nothing. */
export function mergeTeamRosters(
  data: LeaderboardData,
  storeTeams: readonly { slug: string; members: string[] }[],
): {
  sourceTeams: TeamStanding[];
  rosterBySlug: Map<string, string[]>;
  teamByLogin: Map<string, string>;
} {
  const storeBySlug = new Map(storeTeams.map((team) => [team.slug, team]));
  const rosterBySlug = new Map<string, string[]>();

  const sourceTeams = (data.capabilities.teams ? data.teams : []).map((team) => {
    const stored = storeBySlug.get(team.slug);
    if (!stored) {
      rosterBySlug.set(team.slug, team.members);
      return team;
    }
    const byLower = new Map(team.members.map((member) => [member.toLowerCase(), member]));
    for (const member of stored.members) byLower.set(member.toLowerCase(), member);
    const members = [...byLower.values()].sort();
    rosterBySlug.set(team.slug, members);
    return { ...team, members };
  });
  for (const team of storeTeams) {
    if (!rosterBySlug.has(team.slug)) rosterBySlug.set(team.slug, team.members);
  }

  const teamByLogin = new Map<string, string>();
  for (const team of storeTeams) {
    for (const member of team.members) teamByLogin.set(member.toLowerCase(), team.slug);
  }
  for (const [slug, members] of rosterBySlug) {
    for (const member of members) {
      const login = member.toLowerCase();
      if (!teamByLogin.has(login)) teamByLogin.set(login, slug);
    }
  }

  return { sourceTeams, rosterBySlug, teamByLogin };
}

/** Story-lock reachability for every contestant row that will carry a classic
 *  block, in ONE solves read for the whole board.
 *
 *  A row's team is looked up by LOGIN through `mergeTeamRosters`, so it sees
 *  the same complete membership `withTeamStandings` ranks a stage later and a
 *  teammate's solve unlocks the same step for the player row and the team row.
 *  Looking the team up by login rather than by `entry.team` matters because
 *  the rows this is for are mostly CREATED here (`team: null` until that later
 *  stage overlays membership), so on a classic-only event the entry field
 *  alone would call every contestant teamless. A row no roster places is a
 *  team of one and uses its own solves, which is the same rule `/profile`
 *  applies to a viewer with no team.
 *
 *  Returns `undefined` rather than a partial answer: a failed roster or
 *  solves read leaves every row on the clamp it used before, which can
 *  overstate a denominator but never locks a step or exposes its title. */
async function reachableByLogin(
  data: LeaderboardData,
  classicTotals: ReadonlyMap<string, ClassicTotal>,
  challenges: readonly Challenge[],
  stories: readonly Story[],
): Promise<Map<string, Reachable> | undefined> {
  try {
    const { rosterBySlug, teamByLogin } = mergeTeamRosters(data, await listTeams());

    const rows: { login: string; roster: string[] }[] = [];
    for (const [login, total] of classicTotals) {
      if (total.solved <= 0) continue;
      const members = rosterBySlug.get(teamByLogin.get(login.toLowerCase()) ?? "");
      // The login's own spelling leads: the solves hash is keyed on whatever
      // spelling wrote it, so a roster stored in another case must add to it,
      // never replace it (the rule `classic-team.ts` states for the profile).
      rows.push({ login, roster: members ? [...new Set([login, ...members])] : [login] });
    }
    if (rows.length === 0) return undefined;

    const folded = await getTeamClassicTotalsBatch(rows.map((row) => row.roster));
    const reachable = new Map<string, Reachable>();
    rows.forEach((row, i) => {
      const total: ClassicTotal | undefined = folded[i];
      const solved = new Set(total?.itemIds ?? []);
      const records: Record<string, { points?: number }> = {};
      for (const [id, points] of Object.entries(total?.itemPoints ?? {})) records[id] = { points };
      reachable.set(row.login.toLowerCase(), classicReachableDenominator(challenges, stories, solved, records));
    });
    return reachable;
  } catch (err) {
    console.error("classic story-lock reachability unavailable for leaderboard:", errorLabel(err));
    return undefined;
  }
}

/**
 * The team half of this overlay — the ONLY place a team's quiz points are
 * added. `withTeamStandings` calls it once over every team on the
 * board: the source's own (scorer/lambda) teams, on rosters merged with the
 * team store's, and the membership-only rows it synthesises on a source with
 * no team concept of its own (upstash, and the empty source a quiz-only event
 * uses). Those synthesised rows arrive with `points: 0` because there is no
 * per-flag data to dedupe secure-development points from — but their quiz
 * points ARE dedupable, and leaving them at zero put every team on a
 * quiz-only event's DEFAULT board (teams, whenever teams exist) on an
 * all-zero scoreboard while the individual view showed real points.
 *
 * Lives here, and is CALLED by `withTeamStandings`, so that all quiz
 * attribution keeps one owner and one dedupe rule — the union-by-question fold
 * in `getTeamQuizTotalsBatch`, never a sum of member aggregates. Calling it
 * from there rather than moving a pipeline stage is deliberate: the
 * `withModuleContributions → withTeamStandings → withHintPenalties` order is
 * load-bearing (see the page's pipeline comment), and the full team set does
 * not exist until the second of those runs. `withModuleContributions` must
 * NOT also add these points to the source's teams: every scorer team's
 * total would count them twice.
 *
 * Degrades like every other overlay: a failed totals read returns the teams
 * untouched (their quiz points are missing, never wrong), and a failed
 * question list costs only the "answered / total" denominator — the same split
 * that `withModuleContributions` keeps for individuals, and for the same
 * reason.
 */
export async function withTeamQuizPoints(teams: TeamStanding[]): Promise<TeamStanding[]> {
  if (!(await isModuleLive("quiz")) || teams.length === 0) return teams;

  // Settled INDEPENDENTLY — see the note in `withModuleContributions`: the
  // totals carry POINTS (and with them the team board's order), the question
  // list only the DENOMINATOR.
  const [totalsResult, questionsResult] = await Promise.allSettled([teamQuizTotals(teams), listQuestions()]);

  if (totalsResult.status !== "fulfilled") {
    console.error("quiz team totals unavailable for leaderboard:", errorLabel(totalsResult.reason));
    return teams;
  }
  if (questionsResult.status !== "fulfilled") {
    console.error("quiz question list unavailable for leaderboard denominator:", errorLabel(questionsResult.reason));
  }

  return attributeTeams(
    teams,
    quizContributions(
      totalsResult.value,
      questionsResult.status === "fulfilled" ? questionsResult.value.length : 0,
      questionsResult.status === "fulfilled" ? new Set(questionsResult.value.map((q) => q.id)) : undefined,
    ),
  );
}

/**
 * classic's exact counterpart to `withTeamQuizPoints` above — same contract,
 * same degradation, same single owner for the union rule. Read that function's
 * doc comment; everything in it applies here with "challenge solved" in place
 * of "question answered".
 *
 * Kept as its OWN function rather than folded into one multi-module helper so
 * each module's enablement, its two reads, and its failure handling stay
 * independent: a classic-only event must never pay for a quiz read, and a
 * classic outage must never cost a team its quiz points.
 */
export async function withTeamClassicPoints(teams: TeamStanding[]): Promise<TeamStanding[]> {
  if (!(await isModuleLive("classic")) || teams.length === 0) return teams;

  // Settled INDEPENDENTLY — see the note in `withModuleContributions`: the
  // totals carry POINTS (and with them the team board's order), the challenge
  // list only the DENOMINATOR. Stories are read for story-lock reachability.
  const [totalsResult, challengesResult, storiesResult] = await Promise.allSettled([
    teamClassicTotals(teams),
    listChallenges(),
    listStories(),
  ]);

  if (totalsResult.status !== "fulfilled") {
    console.error("classic team totals unavailable for leaderboard:", errorLabel(totalsResult.reason));
    return teams;
  }
  if (challengesResult.status !== "fulfilled") {
    console.error("classic challenge list unavailable for leaderboard denominator:", errorLabel(challengesResult.reason));
  }
  if (storiesResult.status !== "fulfilled") {
    console.error("classic stories unavailable for leaderboard denominator:", errorLabel(storiesResult.reason));
  }

  const challenges = challengesResult.status === "fulfilled" ? challengesResult.value : [];
  // Fail OPEN: an unread story list degrades to `[]`, which counts every live
  // step as reachable (union, locked 0) — a blip must never lock a challenge
  // behind a story nobody could read.
  const stories = storiesResult.status === "fulfilled" ? storiesResult.value : [];
  const liveIds = challengesResult.status === "fulfilled" ? new Set(challenges.map((c) => c.id)) : undefined;

  // If the challenge list read failed, fall back to the old union/clamp logic
  // because we can't compute story-lock reachability without the catalogue.
  const challengesReadFailed = challengesResult.status !== "fulfilled";

  // Compute reachable denominator for each team.
  const reachableDenominators = totalsResult.value.map((total) => {
    const teamSolved = new Set(total.itemIds ?? []);
    const solvedRecords: Record<string, { points?: number }> = {};
    if (total.itemPoints) {
      for (const [id, points] of Object.entries(total.itemPoints)) {
        solvedRecords[id] = { points };
      }
    }
    if (challengesReadFailed) {
      // Fallback: union of live catalogue (unknown, so 0) with solved items = solved count,
      // then clamp to at least solved. This matches the old `denominator` behavior.
      return { total: Math.max(teamSolved.size, total.solved), max: total.points, locked: 0 };
    }
    return classicReachableDenominator(challenges, stories, teamSolved, solvedRecords);
  });

  return attributeTeams(
    teams,
    classicContributions(
      totalsResult.value,
      challenges.length,
      // The live ids, like the quiz and ai counterparts: the chip's
      // denominator is the catalogue UNIONED with solved-then-deleted
      // challenges. Omitting them shows a team's classic denominator as
      // "4 / 6" beside the profile's "4 / 7".
      liveIds,
      reachableDenominators,
    ),
  );
}

/**
 * ai's exact counterpart to `withTeamQuizPoints`/`withTeamClassicPoints`
 * above — same contract, same degradation, same single owner for the union
 * rule. Read `withTeamQuizPoints`'s doc comment; everything in it applies
 * here with "challenge solved" in place of "question answered".
 *
 * Kept as its OWN function for the same reason the other two are: each
 * module's enablement, its two reads, and its failure handling stay
 * independent, so an ai outage never costs a team its quiz or classic points
 * and vice versa.
 */
export async function withTeamAiPoints(teams: TeamStanding[]): Promise<TeamStanding[]> {
  if (!(await isModuleLive("ai")) || teams.length === 0) return teams;

  // Settled INDEPENDENTLY — see the note in `withModuleContributions`: the
  // totals carry POINTS (and with them the team board's order), the
  // challenge list only the DENOMINATOR.
  const [totalsResult, challengesResult] = await Promise.allSettled([teamAiTotals(teams), listAiChallenges()]);

  if (totalsResult.status !== "fulfilled") {
    console.error("ai team totals unavailable for leaderboard:", errorLabel(totalsResult.reason));
    return teams;
  }
  if (challengesResult.status !== "fulfilled") {
    console.error("ai challenge list unavailable for leaderboard denominator:", errorLabel(challengesResult.reason));
  }

  return attributeTeams(
    teams,
    aiContributions(
      totalsResult.value,
      challengesResult.status === "fulfilled" ? challengesResult.value.length : 0,
      challengesResult.status === "fulfilled" ? new Set(challengesResult.value.map((c) => c.id)) : undefined,
    ),
  );
}

/** ONE pipeline for the whole board, never one call per team — see
 *  `getTeamQuizTotalsBatch`'s doc comment (a per-team form billed a 25-team
 *  event 25 Upstash round trips on every render of a `no-store` page). */
function teamQuizTotals(teams: readonly TeamStanding[]): Promise<QuizTotal[]> {
  return getTeamQuizTotalsBatch(teams.map((team) => team.members));
}

/** classic's counterpart, and ONE pipeline for the whole board for the same
 *  reason — see `getTeamClassicTotalsBatch`'s doc comment. */
function teamClassicTotals(teams: readonly TeamStanding[]): Promise<ClassicTotal[]> {
  return getTeamClassicTotalsBatch(teams.map((team) => team.members));
}

/** ai's counterpart, and ONE pipeline for the whole board for the same
 *  reason — see `getTeamAiTotalsBatch`'s doc comment. */
function teamAiTotals(teams: readonly TeamStanding[]): Promise<AiTotal[]> {
  return getTeamAiTotalsBatch(teams.map((team) => team.members));
}

function secureDevelopmentModule(
  points: number,
  patched: number,
  lastActivityAt: string | null,
  apps: Partial<Record<AppId, AppProgress>>,
): ModuleProgress {
  return { points, completed: patched, lastActivityAt, detail: { kind: "secure-development", apps } };
}

/** The row's denominator: the UNION where this path has per-item identity,
 *  a clamp where it does not. See `leaderboard/denominators.ts` for why those
 *  are different answers and not two spellings of one.
 *
 *  `itemIds` arrives only on the TEAM path, whose fold already dedupes members'
 *  solves by id — so the board can show the same figure the profile does
 *  without a single extra read. The individual path reads running
 *  aggregate counters with no memory of which items produced them, so it
 *  clamps.
 *
 *  The clamp is still applied over the union: a catalogue read that failed
 *  leaves `liveIds` empty and the count at 0, so "1 / 0 flags" must never
 *  render. */
function denominator(
  itemIds: readonly string[] | undefined,
  liveIds: ReadonlySet<string> | undefined,
  liveCount: number,
  done: number,
): number {
  if (itemIds && liveIds) return atLeast(unionTotal(liveIds, itemIds), done);
  return atLeast(liveCount, done);
}

/** `total` is CLAMPED to at least `answered` so the "answered / total"
 *  denominator can never fall below its own numerator. Two real ways it
 *  otherwise does: (1) a deleted question — `deleteQuestion` retires the
 *  question but deliberately leaves banked points and the aggregate
 *  `answered` counter alone (see its doc comment), so the list shrinks while
 *  the count doesn't, rendering "1 / 0 answered"; (2) a failed
 *  `listQuestions` above, which degrades the denominator to 0 while the
 *  points and answered counts survive intact. Clamping shows "1 / 1" —
 *  imprecise, but never nonsense. */
function quizModule(total: QuizTotal, totalQuestions: number, liveIds?: ReadonlySet<string>): ModuleProgress {
  return {
    points: total.points,
    completed: total.answered,
    lastActivityAt: total.lastAt,
    detail: {
      kind: "quiz",
      answered: total.answered,
      total: denominator(total.itemIds, liveIds, totalQuestions, total.answered),
      points: total.points,
    },
  };
}

/** classic's counterpart to `quizModule`, clamped for exactly the same two
 *  reasons: (1) `deleteChallenge` retires a challenge but deliberately leaves
 *  banked points and the aggregate `solved` counter alone, so the challenge
 *  list can be SHORTER than a login's solve count and would render "1 / 0
 *  flags"; (2) a failed `listChallenges` degrades the denominator to 0 while
 *  the points and solve counts survive intact. Clamping shows "1 / 1" —
 *  imprecise, but never nonsense.
 *
 *  `reachable` is the story-lock answer — the count of steps this row can
 *  actually reach, plus the solved-but-deleted items, and how many live steps
 *  are still locked. It supersedes the union/clamp for the COUNT whenever it
 *  is present, and `locked` rides along so the row's cross-module denominator
 *  can discount what it cannot do yet. Absent (no stories, or the batched
 *  solves read failed) means the clamp above, and `locked: 0`. */
function classicModule(
  total: ClassicTotal,
  totalChallenges: number,
  liveIds?: ReadonlySet<string>,
  reachable?: Reachable,
): ModuleProgress {
  const denomTotal = reachable
    ? atLeast(reachable.total, total.solved)
    : denominator(total.itemIds, liveIds, totalChallenges, total.solved);
  const locked = reachable?.locked ?? 0;
  return {
    points: total.points,
    completed: total.solved,
    lastActivityAt: total.lastAt,
    detail: {
      kind: "classic",
      solved: total.solved,
      total: denomTotal,
      points: total.points,
      locked,
    },
  };
}

/** ai's counterpart to `classicModule` (same `AiTotal` shape, same clamp
 *  discipline): a deleted ai challenge can leave the catalogue shorter than
 *  a login's solve count, and a failed `listAiChallenges` degrades the
 *  denominator to 0 while points and solves survive intact. Clamping shows
 *  "1 / 1" — imprecise, but never nonsense. */
function aiModule(total: AiTotal, totalChallenges: number, liveIds?: ReadonlySet<string>): ModuleProgress {
  return {
    points: total.points,
    completed: total.solved,
    lastActivityAt: total.lastAt,
    detail: {
      kind: "ai",
      solved: total.solved,
      total: denominator(total.itemIds, liveIds, totalChallenges, total.solved),
      points: total.points,
    },
  };
}

/** The rows the board is MISSING: one per login that holds app-side module
 *  points (quiz, classic, ai, or any combination) and has no entry from the
 *  scoring source. Scored rows come first in the ranked list, so a created
 *  row never displaces one it is fully tied with.
 *
 *  The totals maps are iterated in their ORIGINAL casing (that spelling is all
 *  a created row has to display), while membership is decided on the
 *  lowercased form — a login already on the board keeps its scored row, which
 *  `attributeEntry` has already added the same module points to. Several
 *  modules reporting the same login (in whatever casing) therefore produce
 *  exactly ONE row carrying every reported block and every reported module's
 *  points, never one row each.
 *
 *  Empty whenever every app-side module is off or all their totals reads
 *  failed: each leaves its corresponding map empty, so this creates nothing
 *  without inspecting those conditions again. */
function createdEntries(
  scored: readonly LeaderboardEntry[],
  quizTotals: Map<string, QuizTotal>,
  classicTotals: Map<string, ClassicTotal>,
  aiTotals: Map<string, AiTotal>,
  quizTotalQuestions: number,
  classicTotalChallenges: number,
  aiTotalChallenges: number,
  classicLiveIds?: ReadonlySet<string>,
  classicReachable?: ReadonlyMap<string, Reachable>,
): LeaderboardEntry[] {
  const seen = new Set(scored.map((entry) => entry.login.toLowerCase()));
  // Keyed by lowercased login so the three modules union onto one row;
  // `login` keeps the spelling of whichever module reported it first.
  const pending = new Map<string, { login: string; quiz?: QuizTotal; classic?: ClassicTotal; ai?: AiTotal }>();

  // `answered`/`solved` > 0 is the same gate `attributeEntry` uses to stamp a
  // block: a login with no completed item has no module progress to show and
  // must not become a row.
  for (const [login, total] of quizTotals) {
    const key = login.toLowerCase();
    if (seen.has(key) || total.answered <= 0) continue;
    pending.set(key, { ...(pending.get(key) ?? { login }), quiz: total });
  }
  for (const [login, total] of classicTotals) {
    const key = login.toLowerCase();
    if (seen.has(key) || total.solved <= 0) continue;
    pending.set(key, { ...(pending.get(key) ?? { login }), classic: total });
  }
  for (const [login, total] of aiTotals) {
    const key = login.toLowerCase();
    if (seen.has(key) || total.solved <= 0) continue;
    pending.set(key, { ...(pending.get(key) ?? { login }), ai: total });
  }

  const created: LeaderboardEntry[] = [];
  for (const [key, { login, quiz, classic, ai }] of pending) {
    const modules: Partial<Record<ModuleId, ModuleProgress>> = {};
    if (quiz) modules["quiz"] = quizModule(quiz, quizTotalQuestions);
    if (classic) modules["classic"] = classicModule(classic, classicTotalChallenges, classicLiveIds, classicReachable?.get(key));
    if (ai) modules["ai"] = aiModule(ai, aiTotalChallenges);
    // The modules' own activity time is the only honest value for all three
    // (neither aggregate read has one to give today, so it is null in
    // practice — see getQuizTotals/getClassicTotals/getAiTotals).
    const lastAt = laterOf(laterOf(quiz?.lastAt ?? null, classic?.lastAt ?? null), ai?.lastAt ?? null);
    created.push({
      rank: 0, // stamped by rankByStanding below
      login,
      // Membership is withTeamStandings' to overlay, one step later.
      team: null,
      points: (quiz?.points ?? 0) + (classic?.points ?? 0) + (ai?.points ?? 0),
      // Everything the scorer would have supplied. There is no scoring entry
      // behind this row, so these are genuinely zero rather than unknown.
      patched: 0,
      failed: 0,
      total: 0,
      apps: {},
      updatedAt: lastAt,
      lastSolveAt: lastAt,
      modules,
    });
  }

  return created;
}

/** The later of two possibly-null ISO timestamps, or null when both are. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The `*ByLogin` maps on `overlay` are keyed by LOWERCASED login — see the
 *  folds in `withModuleContributions`.
 *
 *  secure-development is ATTRIBUTED (its points are already inside
 *  `entry.points`); quiz, classic and ai are ADDED. Getting either verb wrong
 *  is silent: attributing an app-side module shows zero, adding the scorer's
 *  doubles it. */
function attributeEntry(entry: LeaderboardEntry, secureDev: boolean, overlay: Overlay): LeaderboardEntry {
  const modules: Partial<Record<ModuleId, ModuleProgress>> = {};
  let points = entry.points;

  if (secureDev && Object.keys(entry.apps).length > 0) {
    modules["secure-development"] = secureDevelopmentModule(
      entry.points,
      entry.patched,
      entry.lastSolveAt ?? null,
      entry.apps,
    );
  }

  const key = entry.login.toLowerCase();

  const quizTotal = overlay.quizByLogin.get(key);
  if (quizTotal && quizTotal.answered > 0) {
    modules["quiz"] = quizModule(quizTotal, overlay.quizTotalQuestions);
    points += quizTotal.points;
  }

  const classicTotal = overlay.classicByLogin.get(key);
  if (classicTotal && classicTotal.solved > 0) {
    modules["classic"] = classicModule(
      classicTotal,
      overlay.classicTotalChallenges,
      overlay.classicLiveIds,
      overlay.classicReachable?.get(key),
    );
    points += classicTotal.points;
  }

  const aiTotal = overlay.aiByLogin.get(key);
  if (aiTotal && aiTotal.solved > 0) {
    modules["ai"] = aiModule(aiTotal, overlay.aiTotalChallenges);
    points += aiTotal.points;
  }

  return { ...entry, points, modules };
}

/** One module's contribution to ONE team, already normalised out of that
 *  module's own vocabulary: `completed` is the gate (nothing completed means
 *  no block and no points) and `progress` the block to stamp. */
type TeamContribution = { points: number; completed: number; progress: ModuleProgress };

/** A whole board's worth of one module's contributions, WITH the module id
 *  they belong under. The id travels with the data rather than as a second
 *  argument to `attributeTeams`, so it is not expressible to stamp one
 *  module's key over another module's numbers. Only the builders below
 *  construct this, and each hard-codes its own id. */
type TeamContributions = { moduleId: ModuleId; contributions: readonly TeamContribution[] };

function quizContributions(
  totals: readonly QuizTotal[],
  totalQuestions: number,
  liveIds?: ReadonlySet<string>,
): TeamContributions {
  return {
    moduleId: "quiz",
    contributions: totals.map((t) => ({
      points: t.points,
      completed: t.answered,
      progress: quizModule(t, totalQuestions, liveIds),
    })),
  };
}

/** One contribution per team, positional with `totals` so each lands on its
 *  own row. `reachableDenominators[i]` is the story-lock figure computed for
 *  that team — itself the union/clamp fallback when the catalogue read failed
 *  — and is what `classicModule` divides by in place of the raw count. */
function classicContributions(
  totals: readonly ClassicTotal[],
  totalChallenges: number,
  liveIds?: ReadonlySet<string>,
  reachableDenominators?: Array<{ total: number; max: number; locked: number }>,
): TeamContributions {
  return {
    moduleId: "classic",
    contributions: totals.map((t, i) => ({
      points: t.points,
      completed: t.solved,
      progress: classicModule(t, totalChallenges, liveIds, reachableDenominators?.[i]),
    })),
  };
}

function aiContributions(
  totals: readonly AiTotal[],
  totalChallenges: number,
  liveIds?: ReadonlySet<string>,
): TeamContributions {
  return {
    moduleId: "ai",
    contributions: totals.map((t) => ({
      points: t.points,
      completed: t.solved,
      progress: aiModule(t, totalChallenges, liveIds),
    })),
  };
}

/** Adds each team's already-deduped module total (`contributions[i]` belongs
 *  to `teams[i]`) to its points and stamps that module's block, then re-ranks
 *  the teams on the new totals — mirroring `withHintPenalties`'s team sort
 *  (`compareTeamStanding`: points, items, then whoever earned their last
 *  points first in any module; original position breaking what is left). Shared verbatim by
 *  every caller and every module, so a source-provided team row and a
 *  synthesised one are attributed by exactly the same rule.
 *
 *  Applying it once per module is safe to chain: each pass adds only its own
 *  module's points and stamps only its own key, and the sort is stable on the
 *  positions the previous pass produced. */
function attributeTeams(teams: TeamStanding[], { moduleId, contributions }: TeamContributions): TeamStanding[] {
  return teams
    .map((team, i) => {
      const contribution = contributions[i];
      if (!contribution || contribution.completed === 0) return { i, team };
      return {
        i,
        team: {
          ...team,
          points: team.points + contribution.points,
          modules: { ...(team.modules ?? {}), [moduleId]: contribution.progress },
        },
      };
    })
    .sort((a, b) => compareTeamStanding(a.team, b.team) || a.i - b.i)
    .map(({ team }, i) => ({ ...team, rank: i + 1 }));
}
