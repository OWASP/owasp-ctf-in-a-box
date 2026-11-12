import "server-only";
import { errorLabel } from "@/lib/error-label";
import { displayNameOf, getPlayerProfiles } from "@/lib/player";
import type { LeaderboardData } from "./types";

type Named = { name: string; image: string | null };

/**
 * Display names and images for rows keyed by player id, from ONE profile read
 * over the distinct ids however many rows there are: a board of hundreds of
 * players is one HMGET, not one per row.
 *
 * A player with a profile gets its name and image. One without (a deleted
 * account, demo data) keeps a non-empty name the row already carries, else
 * gets the id fallback, and has no image.
 *
 * Fails OPEN: a failed read leaves every row on that fallback and logs. Names
 * are display, and a Redis blip must not take the board down with it.
 */
export async function attachNames<T extends { playerId: string }>(rows: T[]): Promise<(T & Named)[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((row) => row.playerId))];
  let profiles: Awaited<ReturnType<typeof getPlayerProfiles>> = new Map();
  try {
    profiles = await getPlayerProfiles(ids);
  } catch (err) {
    console.error("player names unavailable, showing id fallbacks:", errorLabel(err));
  }
  return rows.map((row) => {
    const profile = profiles.get(row.playerId);
    if (profile) return { ...row, name: profile.name, image: profile.image };
    const carried = (row as { name?: unknown }).name;
    return {
      ...row,
      name: typeof carried === "string" && carried ? carried : displayNameOf({ id: row.playerId }),
      image: null,
    };
  });
}

/** The fold's naming stage: every entry and chart line, in one read. Runs
 *  last, after every stage that adds rows (folded.ts). */
export async function withPlayerNames(data: LeaderboardData): Promise<LeaderboardData> {
  const series = data.series ?? [];
  const named = await attachNames<{ playerId: string; name?: string }>([...data.entries, ...series]);
  const entries = data.entries.map((entry, i) => ({ ...entry, name: named[i].name, image: named[i].image }));
  if (!data.series) return { ...data, entries };
  const offset = data.entries.length;
  return {
    ...data,
    entries,
    series: series.map((line, i) => ({ ...line, name: named[offset + i].name, image: named[offset + i].image })),
  };
}
