// The projector board's recent-solves feed (#542).
//
// WRITE SIDE, APP MODULES: a solve route calls `recordRecentSolve` after its
// grader reports a FRESH, non-preview solve. The writer resolves the login's
// team NOW and stores that team's name with the event, so a later rename or
// roster change cannot rewrite history. Fail-open by contract: a feed write
// must never fail a solve that already landed (same rule as activity-log.ts).
//
// WRITE SIDE, SECURE DEVELOPMENT: scorer/src/store.js writes the same keys
// when its own HSETNX reports a newly banked solve; sync remains the only
// score-transport writer. The event shape and dedupe id are duplicated
// there deliberately — the two services share Redis, not code.
//
// READ SIDE: the public route and the display page get a field-by-field
// projection built only from the public-safe listers. The stored event has no
// login and the projection has no challenge id, app id or team slug. A title
// is resolved at read time and the whole line is dropped when its module is
// off, its challenge is gone, its target is disabled, or its classic story
// step is locked for an anonymous viewer (ADR 60). The admin-only activity
// log is never read here.
import "server-only";
import type { AppId } from "@/lib/apps";
import { getChallengeCatalog } from "@/lib/challenges";
import { listChallenges, listStories } from "@/lib/classic-store";
import { getEnabledApps } from "@/lib/enabled-apps";
import { isModuleLive } from "@/lib/enabled-modules";
import { listQuestions } from "@/lib/quiz-store";
import { listAiChallenges } from "@/lib/ai-store";
import { isChallengeVisible } from "@/lib/classic-release";
import { isLocked, storyPositions } from "@/lib/story-lock";
import { getViewerTeam } from "@/lib/team-store";
import { upstashEval, upstashPipeline } from "@/lib/upstash";
import { errorLabel } from "@/lib/error-label";
import {
  RECENT_SOLVES_DATA_KEY,
  RECENT_SOLVES_KEY,
  RECENT_SOLVES_LIMIT,
  RECENT_SOLVES_MAX,
  type RecentSolveItem,
  type RecentSolveModule,
} from "@/lib/recent-solves-keys";

/** One event as stored in the data hash. `team` is the slug used for dedupe
 *  and is NEVER returned; `teamName` is the public credit captured at solve
 *  time. There is no login field, by construction. */
type StoredRecentSolve = {
  module: RecentSolveModule;
  app?: AppId;
  challengeId: string;
  points: number;
  team: string;
  teamName: string;
  at: string;
};

/** How long a solve route waits on the feed write. The solve already landed;
 *  this is the same fail-open bound activity-log.ts uses. */
const WRITE_TIMEOUT_MS = 1500;

/** Atomic: add only if this team has not already recorded this item, write
 *  its data, then trim both the sorted set and the data hash together. The
 *  sorted set member is the deterministic id, so a teammate solving the same
 *  challenge later does not add a second line (the team score did not move
 *  either). ARGV: id, score, event JSON, retention cap. */
export const RECORD_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
local last = -(tonumber(ARGV[4]) + 1)
local evicted = redis.call('ZRANGE', KEYS[1], 0, last)
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, last)
for i = 1, #evicted do redis.call('HDEL', KEYS[2], evicted[i]) end
return 1
`;

type AppSolveModule = Exclude<RecentSolveModule, "secure-development">;

function eventId(module: RecentSolveModule, app: AppId | undefined, challengeId: string, team: string): string {
  return [module, app ?? "-", challengeId, team].join(":");
}

function isAppId(value: unknown): value is AppId {
  return (
    value === "juice-shop" ||
    value === "dvwa" ||
    value === "webgoat" ||
    value === "securityshepherd" ||
    value === "vulnerableapp" ||
    value === "vampi"
  );
}

function parseStored(raw: unknown): StoredRecentSolve | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = row.module;
  if (kind !== "classic" && kind !== "quiz" && kind !== "ai" && kind !== "secure-development") return null;
  if (typeof row.challengeId !== "string" || !row.challengeId || row.challengeId.length > 200) return null;
  if (typeof row.team !== "string" || !row.team || row.team.length > 200) return null;
  if (typeof row.teamName !== "string" || !row.teamName || row.teamName.length > 200) return null;
  if (typeof row.points !== "number" || !Number.isFinite(row.points) || row.points < 0) return null;
  if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) return null;
  if (kind === "secure-development") {
    if (!isAppId(row.app)) return null;
  } else if (row.app !== undefined) {
    return null;
  }
  return {
    module: kind,
    ...(kind === "secure-development" ? { app: row.app as AppId } : {}),
    challengeId: row.challengeId,
    points: row.points,
    team: row.team,
    teamName: row.teamName,
    at: row.at,
  };
}

/**
 * Record one FRESH app-module solve. Never throws, and resolves within
 * `WRITE_TIMEOUT_MS` even when Redis hangs; a lost line is preferable to a
 * failed solve.
 */
export async function recordRecentSolve(input: {
  module: AppSolveModule;
  challengeId: string;
  points: number;
  login: string;
  at?: string;
}): Promise<void> {
  try {
    const team = await getViewerTeam(input.login);
    if (!team || !team.slug || !team.name) return;
    const at = input.at ?? new Date().toISOString();
    const ms = Date.parse(at);
    const event: StoredRecentSolve = {
      module: input.module,
      challengeId: input.challengeId,
      points: Number.isFinite(input.points) && input.points >= 0 ? input.points : 0,
      team: team.slug,
      teamName: team.name,
      at,
    };
    const write = upstashEval(
      RECORD_SCRIPT,
      [RECENT_SOLVES_KEY, RECENT_SOLVES_DATA_KEY],
      [
        eventId(event.module, undefined, event.challengeId, event.team),
        String(Number.isFinite(ms) ? ms : Date.now()),
        JSON.stringify(event),
        String(RECENT_SOLVES_MAX),
      ],
    ).then(
      () => undefined,
      (err) => console.warn("[recent-solves] write failed", errorLabel(err)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WRITE_TIMEOUT_MS);
    });
    try {
      await Promise.race([write, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn("[recent-solves] write failed", errorLabel(err));
  }
}

async function classicTitles(): Promise<Map<string, string> | null> {
  if (!(await isModuleLive("classic"))) return null;
  try {
    const [challenges, stories] = await Promise.all([listChallenges(), listStories()]);
    const positions = storyPositions(stories, new Set(challenges.map((c) => c.id)));
    const nowMs = Date.now();
    const titles = new Map<string, string>();
    for (const challenge of challenges) {
      // A disabled or not-yet-released challenge is hidden from contestants
      // (#637); the projector is a contestant surface, so its line goes too.
      if (!isChallengeVisible(challenge, nowMs)) continue;
      const pos = positions.get(challenge.id);
      // A story step beyond the first is locked for a signed-out projector
      // audience regardless of which team solved it. Drop the line rather
      // than reveal its title OR its point value.
      if (pos && isLocked(pos, new Set())) continue;
      titles.set(challenge.id, challenge.title);
    }
    return titles;
  } catch {
    return null;
  }
}

async function quizTitles(): Promise<Map<string, string> | null> {
  if (!(await isModuleLive("quiz"))) return null;
  try {
    return new Map((await listQuestions()).map((q) => [q.id, q.prompt]));
  } catch {
    return null;
  }
}

async function aiTitles(): Promise<Map<string, string> | null> {
  if (!(await isModuleLive("ai"))) return null;
  try {
    return new Map((await listAiChallenges()).map((c) => [c.id, c.title]));
  } catch {
    return null;
  }
}

/** SD catalogue keys are `<app>:<id>`; only targets the event still serves
 *  are included. A failed/empty catalogue hides all SD lines for this read. */
async function secureDevTitles(): Promise<Map<string, string> | null> {
  if (!(await isModuleLive("secure-development"))) return null;
  try {
    const [catalog, enabled] = await Promise.all([getChallengeCatalog(), getEnabledApps()]);
    if (!catalog) return null;
    const apps = new Set(enabled.map((a) => a.id));
    const titles = new Map<string, string>();
    for (const [app, list] of Object.entries(catalog.byApp)) {
      if (!isAppId(app) || !apps.has(app)) continue;
      for (const challenge of list ?? []) titles.set(`${app}:${challenge.id}`, challenge.description);
    }
    return titles;
  } catch {
    return null;
  }
}

/**
 * Newest-first public feed. Throws on a failed Redis read (the route turns
 * that into 503); individual malformed rows and now-hidden items are skipped,
 * never fatal.
 */
export async function listRecentSolves(limit: number = RECENT_SOLVES_LIMIT): Promise<RecentSolveItem[]> {
  const take = Math.max(0, Math.min(Math.trunc(limit), RECENT_SOLVES_MAX));
  if (take === 0) return [];

  const [range] = await upstashPipeline([["ZREVRANGE", RECENT_SOLVES_KEY, 0, take - 1]]);
  if (range.error) throw new Error("recent solves read failed");
  const ids = Array.isArray(range.result) ? range.result.filter((id): id is string => typeof id === "string") : [];
  if (ids.length === 0) return [];

  const [data] = await upstashPipeline([["HMGET", RECENT_SOLVES_DATA_KEY, ...ids]]);
  if (data.error) throw new Error("recent solves read failed");
  const values = Array.isArray(data.result) ? data.result : [];
  const events = ids.map((_, i) => parseStored(values[i])).filter((e): e is StoredRecentSolve => e !== null);

  const has = (module: RecentSolveModule) => events.some((e) => e.module === module);
  const [classic, quiz, ai, secureDev] = await Promise.all([
    has("classic") ? classicTitles() : null,
    has("quiz") ? quizTitles() : null,
    has("ai") ? aiTitles() : null,
    has("secure-development") ? secureDevTitles() : null,
  ]);

  const out: RecentSolveItem[] = [];
  for (const event of events) {
    let title: string | undefined;
    if (event.module === "classic") title = classic?.get(event.challengeId);
    else if (event.module === "quiz") title = quiz?.get(event.challengeId);
    else if (event.module === "ai") title = ai?.get(event.challengeId);
    else title = secureDev?.get(`${event.app}:${event.challengeId}`);
    if (!title) continue;
    out.push({
      team: event.teamName,
      title,
      module: event.module,
      points: event.points,
      at: event.at,
    });
  }
  return out;
}
