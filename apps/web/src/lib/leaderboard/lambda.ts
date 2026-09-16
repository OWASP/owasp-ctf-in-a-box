import "server-only";
import type { AppId } from "@/lib/apps";
import { rankByStanding } from "./rank";
import type { LeaderboardSource } from "./source";
import type {
  AppProgress,
  ChallengeCatalog,
  LeaderboardData,
  LeaderboardEntry,
  PlayerSeries,
  TeamSeries,
  TeamStanding,
  UserProfile,
} from "./types";

// Shape returned by the deployed Lambda's real scoring endpoint:
// { leaderboard: [{ rank, author, points, lastSolveAt,
//                   apps: { "juice-shop": { solved, total }, ... } }],
//   series: [{ login, points: [{ t, score }, ...] }, ...],
//   teams: [{ rank, slug, name, captain, members, points, lastSolveAt, apps }, ...],
//   teamSeries: [{ slug, name, points: [{ t, score }, ...] }, ...] }
// There is no per-app point/max breakdown in this source. `series`/`teams`/
// `teamSeries` are all additive — read defensively since an older scorer
// deployment may not send any of them at all.
type LambdaAppProgress = {
  solved: number;
  total: number;
  /** Ids of the challenges this entry/team has solved — joins to `catalog`.
   *  Absent from an older scorer deployment (then challenges stay hidden). */
  solvedIds?: string[];
};
type LambdaEntry = {
  rank: number;
  author: string;
  points: number;
  /** ISO time of the most recent solve — added for tie-breaking. */
  lastSolveAt?: string | null;
  apps: Partial<Record<AppId, LambdaAppProgress>>;
};
/** One catalogue entry: a challenge's display metadata, keyed by its id. */
type LambdaCatalogEntry = { id: string; name: string; points: number; owasp: string | null };
type LambdaCatalog = Partial<Record<AppId, LambdaCatalogEntry[]>>;
// Loosely typed on purpose — this is unvalidated network input, tolerated
// (not assumed) to match the documented `series`/`teams`/`teamSeries` shapes.
type RawSeriesPoint = { t?: unknown; score?: unknown };
type RawPlayerSeries = { login?: unknown; points?: unknown };
type RawTeam = {
  rank?: unknown;
  slug?: unknown;
  name?: unknown;
  captain?: unknown;
  members?: unknown;
  points?: unknown;
  apps?: unknown;
};
type RawTeamSeries = { slug?: unknown; name?: unknown; points?: unknown };
type LambdaResponse = {
  leaderboard: LambdaEntry[];
  series?: unknown;
  teams?: unknown;
  teamSeries?: unknown;
  catalog?: unknown;
};

/** Defensively maps the Lambda's `series` field, tolerating it being absent,
 *  empty, or shaped unexpectedly (an older scorer deployment). Malformed
 *  points/players are dropped rather than throwing — a bad `series` should
 *  never take down the leaderboard, it should just fail to chart. */
function toSeries(raw: unknown): PlayerSeries[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const series: PlayerSeries[] = [];
  for (const item of raw as RawPlayerSeries[]) {
    if (!item || typeof item !== "object") continue;
    const { login, points } = item;
    if (typeof login !== "string" || !Array.isArray(points)) continue;
    const validPoints = (points as RawSeriesPoint[]).filter(
      (p): p is { t: string; score: number } =>
        !!p && typeof p === "object" && typeof p.t === "string" && typeof p.score === "number" && Number.isFinite(p.score),
    );
    if (validPoints.length > 0) series.push({ login, points: validPoints });
  }
  return series.length > 0 ? series : undefined;
}

/** Defensively maps the Lambda's `teams` field, tolerating it being absent
 *  or shaped unexpectedly (an older scorer deployment). Malformed team
 *  entries are dropped rather than throwing — a bad `teams` entry should
 *  never take down the leaderboard, it should just be excluded from
 *  standings. Always returns an array (never undefined) so callers can
 *  check `.length` to decide the `teams` capability. */
function toTeams(raw: unknown, catalog: LambdaCatalog): TeamStanding[] {
  if (!Array.isArray(raw)) return [];
  const teams: TeamStanding[] = [];
  for (const item of raw as RawTeam[]) {
    if (!item || typeof item !== "object") continue;
    const { rank, slug, name, captain, members, points, apps } = item;
    if (
      typeof rank !== "number" ||
      !Number.isFinite(rank) ||
      typeof slug !== "string" ||
      typeof name !== "string" ||
      typeof captain !== "string" ||
      typeof points !== "number" ||
      !Number.isFinite(points) ||
      !Array.isArray(members)
    ) {
      continue;
    }
    const validMembers = members.filter((m): m is string => typeof m === "string");
    teams.push({ rank, slug, name, captain, members: validMembers, points, apps: toTeamApps(apps, catalog) });
  }
  return teams;
}

/** Builds a team's per-app progress (with the union of solved challenges) from
 *  its raw `apps` map, mirroring `toAppProgress` for entries. Returns undefined
 *  when the team has no valid app data or no catalogue exists — the teams view
 *  then falls back to showing members only. */
function toTeamApps(raw: unknown, catalog: LambdaCatalog): TeamStanding["apps"] {
  if (!raw || typeof raw !== "object" || Object.keys(catalog).length === 0) return undefined;
  const apps: NonNullable<TeamStanding["apps"]> = {};
  for (const [app, progress] of Object.entries(raw as Record<string, unknown>)) {
    if (!progress || typeof progress !== "object") continue;
    const p = progress as { solved?: unknown; total?: unknown; solvedIds?: unknown };
    if (typeof p.solved !== "number" || typeof p.total !== "number") continue;
    const solvedIds = Array.isArray(p.solvedIds) ? p.solvedIds.filter((id): id is string => typeof id === "string") : [];
    apps[app as AppId] = toAppProgress(app as AppId, { solved: p.solved, total: p.total, solvedIds }, catalog);
  }
  return Object.keys(apps).length > 0 ? apps : undefined;
}

/** Defensively maps the Lambda's `teamSeries` field, mirroring `toSeries`
 *  but keyed by team instead of player. */
function toTeamSeries(raw: unknown): TeamSeries[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const series: TeamSeries[] = [];
  for (const item of raw as RawTeamSeries[]) {
    if (!item || typeof item !== "object") continue;
    const { slug, name, points } = item;
    if (typeof slug !== "string" || typeof name !== "string" || !Array.isArray(points)) continue;
    const validPoints = (points as RawSeriesPoint[]).filter(
      (p): p is { t: string; score: number } =>
        !!p && typeof p === "object" && typeof p.t === "string" && typeof p.score === "number" && Number.isFinite(p.score),
    );
    if (validPoints.length > 0) series.push({ slug, name, points: validPoints });
  }
  return series.length > 0 ? series : undefined;
}

/** Defensively maps the Lambda's `catalog` field (per-target challenge
 *  metadata, added by newer scorers). Tolerates it being absent or malformed —
 *  a bad catalog should just hide the per-challenge view, never throw. Entries
 *  missing id/name/points are dropped; a target with no valid entries is
 *  omitted, so `Object.keys(catalog).length` decides the `challenges`
 *  capability. */
function toCatalog(raw: unknown): LambdaCatalog {
  if (!raw || typeof raw !== "object") return {};
  const catalog: LambdaCatalog = {};
  for (const [app, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries: LambdaCatalogEntry[] = [];
    for (const c of list as Record<string, unknown>[]) {
      if (!c || typeof c !== "object") continue;
      const { id, name, points, owasp } = c;
      if (typeof id !== "string" || typeof name !== "string" || typeof points !== "number" || !Number.isFinite(points)) {
        continue;
      }
      entries.push({ id, name, points, owasp: typeof owasp === "string" ? owasp : null });
    }
    if (entries.length > 0) catalog[app as AppId] = entries;
  }
  return catalog;
}

/** Joins a target's catalogue against an entry/team's solved ids into the
 *  per-challenge `ChallengeResult[]` the UI renders — solved ids become
 *  "patched", everything else "open" (this source has no failing-run data). */
/** The catalogue in its public shape (`key`, not the Lambda's `id`), sent
 *  once per response. Empty → undefined, so a source with no per-challenge
 *  view carries no field rather than an empty object. */
function toPublicCatalog(catalog: LambdaCatalog): ChallengeCatalog | undefined {
  const out: ChallengeCatalog = {};
  for (const [app, list] of Object.entries(catalog) as [AppId, LambdaCatalogEntry[]][]) {
    out[app] = list.map((c) => ({ key: c.id, name: c.name, points: c.points, owasp: c.owasp }));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Builds the normalized per-app progress, enriching it with per-challenge
 *  detail (and catalogue-derived points/max) when a catalogue exists for the
 *  target. Without one, points/max stay 0 and no challenge list is attached —
 *  the pre-catalog behaviour. */
function toAppProgress(app: AppId, progress: LambdaAppProgress, catalog: LambdaCatalog): AppProgress {
  const cat = catalog[app];
  if (!cat) {
    return { app, points: 0, maxPoints: 0, patched: progress.solved, total: progress.total };
  }
  // Only ids the catalogue still knows: a challenge removed from the rubric
  // after it was solved must not become a nameless row downstream.
  const known = new Set(cat.map((c) => c.id));
  const solvedIds = (progress.solvedIds ?? []).filter((id) => known.has(id));
  const solved = new Set(solvedIds);
  const maxPoints = cat.reduce((sum, c) => sum + c.points, 0);
  const points = cat.filter((c) => solved.has(c.id)).reduce((sum, c) => sum + c.points, 0);
  // The row carries the ids, never the expanded catalogue (issue #434) —
  // app-breakdown.tsx joins them against LeaderboardData.catalog at render.
  return { app, points, maxPoints, patched: progress.solved, total: progress.total, solvedIds };
}

function toEntry(raw: LambdaEntry, catalog: LambdaCatalog): LeaderboardEntry {
  const apps: LeaderboardEntry["apps"] = {};
  let patched = 0;
  let total = 0;
  for (const [app, progress] of Object.entries(raw.apps) as [AppId, LambdaAppProgress][]) {
    patched += progress.solved;
    total += progress.total;
    apps[app] = toAppProgress(app, progress, catalog);
  }
  return {
    rank: raw.rank,
    login: raw.author,
    team: null,
    points: raw.points,
    patched,
    // The Lambda only reports solved/total — unsolved challenges are
    // "remaining", not "failed" (there is no failing-test-run data in this
    // source), so failed is always 0 and the UI derives remaining instead.
    failed: 0,
    total,
    apps,
    // A solve is the only thing that updates this source, so the last solve
    // is also the last update.
    updatedAt: raw.lastSolveAt ?? null,
    lastSolveAt: raw.lastSolveAt ?? null,
  };
}

export const lambdaSource: LeaderboardSource = {
  async getLeaderboard(): Promise<LeaderboardData> {
    const base = process.env.LEADERBOARD_API_URL;
    if (!base) throw new Error("LEADERBOARD_API_URL is not set");
    const res = await fetch(`${base.replace(/\/$/, "")}/leaderboard`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) throw new Error(`Lambda leaderboard fetch failed: HTTP ${res.status}`);
    const data = (await res.json()) as LambdaResponse;
    const catalog = toCatalog(data.catalog);
    const teams = toTeams(data.teams, catalog);
    return {
      // Re-rank rather than trusting the Lambda's rank field, so the
      // lastSolveAt tie-break is applied even if the Lambda ordered ties
      // arbitrarily.
      entries: rankByStanding(data.leaderboard.map((e) => toEntry(e, catalog))),
      teams,
      generatedAt: new Date().toISOString(),
      capabilities: { apps: true, teams: teams.length > 0, challenges: Object.keys(catalog).length > 0 },
      catalog: toPublicCatalog(catalog),
      series: toSeries(data.series),
      teamSeries: toTeamSeries(data.teamSeries),
    };
  },

  async getUser(login: string): Promise<UserProfile | null> {
    const data = await this.getLeaderboard();
    const entry = data.entries.find((e) => e.login === login);
    if (!entry) return null;
    return {
      login: entry.login,
      team: null,
      teamName: null,
      points: entry.points,
      // A module's ceiling is the sum of its targets' ceilings — the same
      // aggregation mockSource does. This used to be a hardcoded 0 while
      // `toAppProgress` was computing a real `maxPoints` per target from the
      // catalogue, so /profile's secure-development header read "8 / 0 pts"
      // (earned 8, available 0) beside target rows that summed to 668.
      maxPoints: Object.values(entry.apps).reduce((n, app) => n + (app?.maxPoints ?? 0), 0),
      patched: entry.patched,
      failed: entry.failed,
      total: entry.total,
      apps: Object.values(entry.apps).filter(Boolean) as UserProfile["apps"],
      catalog: data.catalog,
      updatedAt: entry.updatedAt,
    };
  },
};
