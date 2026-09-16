import "server-only";
import type { LeaderboardSource } from "./source";
import type { LeaderboardData, LeaderboardEntry, PlayerSeries, TeamSeries, TeamStanding, UserProfile } from "./types";
import { buildMockEntries, buildMockTeams, findMockSample, buildMockCatalog } from "./mock-data";

/** Small deterministic string hash — used only to vary each mock player's
 *  "solving history" (step count, stagger, curve shape) without adding a
 *  random-number dependency or making the fixture flaky between renders. */
function seedFrom(login: string): number {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return h;
}

/** Splits `finalScore` into 1..desiredSteps positive integer increments that
 *  sum to exactly `finalScore`, with varied sizes (so lines have visibly
 *  different slopes, not a uniform ramp). Never returns more steps than the
 *  score has points to spread across, and never a non-positive increment. */
function buildIncrements(finalScore: number, desiredSteps: number, seed: number): number[] {
  const steps = Math.max(1, Math.min(desiredSteps, finalScore));
  if (steps === 1) return [finalScore];
  const weights = Array.from({ length: steps }, (_, i) => 1 + ((seed >> (i * 3)) % 5));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const increments = weights.map((w) => Math.max(1, Math.round((w / weightSum) * finalScore)));
  let diff = finalScore - increments.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard < steps * Math.max(1, Math.abs(diff)) + steps * 4) {
    const idx = guard % steps;
    if (diff > 0) {
      increments[idx] += 1;
      diff -= 1;
    } else if (increments[idx] > 1) {
      increments[idx] -= 1;
      diff += 1;
    }
    guard++;
  }
  return increments;
}

/** Synthesizes a plausible cumulative-score history for the board's top
 *  scorers — staggered start times and different "slopes" per player, ending
 *  exactly at that player's current mock score — so the leaderboard line
 *  chart has something realistic to draw in the fixture/demo/dev-stack. */
function synthesizeSeries(entries: LeaderboardEntry[], generatedAt: string): PlayerSeries[] {
  const endMs = Date.parse(generatedAt);
  return entries
    .filter((e) => e.points > 0)
    .slice(0, 10)
    .map((entry): PlayerSeries => {
      const seed = seedFrom(entry.login);
      const entryEndMs = entry.updatedAt ? Date.parse(entry.updatedAt) : endMs;
      const steps = 3 + (seed % 4); // 3..6 desired points
      const increments = buildIncrements(entry.points, steps, seed);
      // Stagger each player's start time (4-9 hours of "history") and shape
      // the pacing (linear vs. an eased curve) so lines don't all begin at
      // once or run in lockstep.
      const spanMs = (4 + (seed % 6)) * 60 * 60 * 1000;
      const startMs = entryEndMs - spanMs;
      const eased = seed % 2 === 1;
      let cumulative = 0;
      const points = increments.map((inc, i) => {
        cumulative += inc;
        const frac = (i + 1) / increments.length;
        const shaped = eased ? Math.pow(frac, 1.6) : frac;
        const t = new Date(startMs + shaped * spanMs).toISOString();
        return { t, score: cumulative };
      });
      return { login: entry.login, points };
    });
}

/** Mirrors `synthesizeSeries` but for team totals — same staggered-start,
 *  eased-curve synthesis, keyed by team slug instead of login. Each team's
 *  "history" ends around its latest member's last solve, so the team chart
 *  doesn't run further into the future than the individual one. */
function synthesizeTeamSeries(
  teams: TeamStanding[],
  entries: LeaderboardEntry[],
  generatedAt: string,
): TeamSeries[] {
  const endMs = Date.parse(generatedAt);
  const entryByLogin = new Map(entries.map((e) => [e.login, e]));
  return teams
    .filter((t) => t.points > 0)
    .map((team): TeamSeries => {
      const seed = seedFrom(team.slug);
      const memberEndTimes = team.members
        .map((login) => entryByLogin.get(login)?.updatedAt)
        .filter((v): v is string => Boolean(v))
        .map((v) => Date.parse(v));
      const teamEndMs = memberEndTimes.length > 0 ? Math.max(...memberEndTimes) : endMs;
      const steps = 3 + (seed % 4); // 3..6 desired points
      const increments = buildIncrements(team.points, steps, seed);
      const spanMs = (4 + (seed % 6)) * 60 * 60 * 1000;
      const startMs = teamEndMs - spanMs;
      const eased = seed % 2 === 1;
      let cumulative = 0;
      const points = increments.map((inc, i) => {
        cumulative += inc;
        const frac = (i + 1) / increments.length;
        const shaped = eased ? Math.pow(frac, 1.6) : frac;
        const t = new Date(startMs + shaped * spanMs).toISOString();
        return { t, score: cumulative };
      });
      return { slug: team.slug, name: team.name, points };
    });
}

export const mockSource: LeaderboardSource = {
  async getLeaderboard(): Promise<LeaderboardData> {
    const entries = buildMockEntries();
    const teams = buildMockTeams(entries);
    const generatedAt = new Date().toISOString();
    return {
      entries,
      teams,
      generatedAt,
      capabilities: { apps: true, teams: true, challenges: true },
      catalog: buildMockCatalog(),
      series: synthesizeSeries(entries, generatedAt),
      teamSeries: synthesizeTeamSeries(teams, entries, generatedAt),
    };
  },

  async getUser(login: string): Promise<UserProfile | null> {
    if (!findMockSample(login)) return null;
    const entries = buildMockEntries();
    const teams = buildMockTeams(entries);
    const entry = entries.find((e) => e.login === login);
    if (!entry) return null;
    const maxPoints = Object.values(entry.apps).reduce((n, a) => n + (a?.maxPoints ?? 0), 0);
    return {
      login: entry.login,
      team: entry.team,
      teamName: teams.find((t) => t.slug === entry.team)?.name ?? entry.team,
      points: entry.points,
      maxPoints,
      patched: entry.patched,
      failed: entry.failed,
      total: entry.total,
      apps: Object.values(entry.apps).filter(Boolean) as UserProfile["apps"],
      catalog: buildMockCatalog(),
      updatedAt: entry.updatedAt,
    };
  },
};
