import "server-only";
import type { LeaderboardSource } from "./source";
import type { LeaderboardData, LeaderboardEntry, UserProfile } from "./types";

// Direct read of the CURRENT real Upstash schema written by the scorer's
// `pushLeaderboard()` (the scorer repo's .github/actions/ctf-score/src/upstash.ts):
//   ZADD leaderboard <score> <login>          (one global ZSET — latest write wins)
//   HSET team:<login> score maxScore patched total sha pr updatedAt
// No per-app breakdown, no per-challenge data, no real teams exist yet in
// this schema — capabilities reflect that. This adapter never writes; the
// shared REST /pipeline client lives in @/lib/upstash.

import { upstashPipeline as pipeline } from "@/lib/upstash";

function hgetallToObject(flat: unknown): Record<string, string> {
  const arr = Array.isArray(flat) ? (flat as string[]) : [];
  const obj: Record<string, string> = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
}

async function fetchEntries(limit: number): Promise<LeaderboardEntry[]> {
  const [zrange] = await pipeline([["ZRANGE", "leaderboard", "0", String(limit - 1), "REV", "WITHSCORES"]]);
  // A per-command error reply resolves rather than throws; reading past it
  // would serve an empty board with no log (#499, the #215 class).
  if (zrange.error) throw new Error(`Upstash ZRANGE leaderboard failed: ${zrange.error}`);
  const flat = Array.isArray(zrange.result) ? (zrange.result as string[]) : [];
  const logins: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    logins.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  if (logins.length === 0) return [];

  const hashResults = await pipeline(logins.map((login) => ["HGETALL", `team:${login}`]));
  const failed = hashResults.find((r) => r?.error);
  if (failed) throw new Error(`Upstash HGETALL team totals failed: ${failed.error}`);
  return logins.map((login, i) => {
    const hash = hgetallToObject(hashResults[i]?.result);
    const patched = Number(hash.patched ?? 0);
    const total = Number(hash.total ?? 0);
    return {
      rank: i + 1,
      login,
      team: null,
      points: scores[i],
      patched,
      failed: Math.max(0, total - patched),
      total,
      apps: {},
      updatedAt: hash.updatedAt ?? null,
      // The hash's updatedAt is stamped on scoring changes, i.e. solves.
      lastSolveAt: hash.updatedAt ?? null,
      lastSha: hash.sha ?? null,
      lastPr: hash.pr ? Number(hash.pr) : null,
    };
  });
}

export const upstashSource: LeaderboardSource = {
  async getLeaderboard(): Promise<LeaderboardData> {
    const entries = await fetchEntries(50);
    return {
      entries,
      teams: [],
      generatedAt: new Date().toISOString(),
      // teams stays false: this schema has no per-flag data client-side, so
      // there's no way to dedupe a flag two teammates both solved. Real team
      // points are only ever computed on the scorer/lambda path, which has
      // that per-flag detail; `withTeamStandings` overlays membership onto
      // this source without fabricating a summed score (see team-standings.ts).
      capabilities: { apps: false, teams: false, challenges: false },
      // No cumulative-score history in this schema — the ZSET only ever
      // holds each player's current total, not point-in-time readings. The
      // leaderboard chart component treats `series: undefined` as "hide".
    };
  },

  async getUser(login: string): Promise<UserProfile | null> {
    const [hashResult] = await pipeline([["HGETALL", `team:${login}`]]);
    const hash = hgetallToObject(hashResult.result);
    if (Object.keys(hash).length === 0) return null;
    const patched = Number(hash.patched ?? 0);
    const total = Number(hash.total ?? 0);
    return {
      login,
      team: null,
      teamName: null,
      points: Number(hash.score ?? 0),
      maxPoints: Number(hash.maxScore ?? 0),
      patched,
      failed: Math.max(0, total - patched),
      total,
      apps: [],
      updatedAt: hash.updatedAt ?? null,
    };
  },
};
