import "server-only";
import { aiSolvesKey } from "@/lib/ai-keys";
import { classicSolvesKey } from "@/lib/classic-keys";
import { quizAnswersKey } from "@/lib/quiz-keys";
import { getEnabledModuleIds } from "@/lib/enabled-modules";
import { upstashPipeline } from "@/lib/upstash";
import type { LeaderboardData, PlayerSeries, SeriesPoint, TeamSeries } from "./types";

/**
 * Puts the app-side modules onto the chart.
 *
 * The chart used to plot the SOURCE's history alone — secure-development
 * scoring events from the scorer — while quiz, classic and ai points were
 * stamped on afterwards as aggregate totals with no timeline. On a
 * multi-module event that made the picture contradict the numbers under it: a
 * contestant with 202 points had a line sitting at 2, and the only thing
 * stopping it reading as a defect was a caption admitting what it left out
 * (issue #415).
 *
 * The timeline was always there to be read. All three modules record
 * `{points, at}` per item — quiz per question, classic and ai per challenge —
 * so this reads those hashes and turns them into the events the chart wants.
 * The aggregate counters the totals come from (`ctf:quiz:points` and friends)
 * cannot serve here: they carry no `at`.
 *
 * GROSS, deliberately. Hint spend is stored as points, not as timed reveals
 * (`ctf:hints:spent` keeps the price so historical pricing survives a price
 * change), so there is no instant to subtract it at and a netted line would be
 * invented. The row keeps showing net with its −N marker — the same split
 * every module block already uses: gross in the parts, net on the row.
 */

/** One scoring event, before it is folded into a cumulative series. */
type Earned = { itemId: string; points: number; at: string };

/** `{points, at}` as the three stores write it. Anything malformed is dropped
 *  rather than thrown on: a hand-edited hash, a half-written record or an
 *  unparseable `at` must cost the chart one point, never the whole board. */
function parseEarned(raw: unknown): { points: number; at: string } | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { points, at } = parsed as Record<string, unknown>;
  if (typeof points !== "number" || !Number.isFinite(points)) return null;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  return { points, at };
}

/** HGETALL replies arrive flat: [field, value, field, value, …]. */
function readEvents(reply: { result?: unknown; error?: string } | undefined): Earned[] {
  // `.error` is checked because upstashPipeline does NOT throw on a per-command
  // failure — it returns the error positionally, and reading `.result` past it
  // turns a NOAUTH into "this contestant scored nothing".
  if (!reply || reply.error) return [];
  const flat = Array.isArray(reply.result) ? (reply.result as unknown[]) : [];
  const events: Earned[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const itemId = flat[i];
    const earned = parseEarned(flat[i + 1]);
    if (typeof itemId === "string" && earned) events.push({ itemId, ...earned });
  }
  return events;
}

/** Events for every login, per enabled module, in ONE pipeline. The same read
 *  the team totals already make (`getTeamQuizTotalsBatch` and its siblings) —
 *  this keeps the events instead of folding them into a total. */
async function readModuleEvents(logins: readonly string[]): Promise<Map<string, Earned[]>> {
  const byLogin = new Map<string, Earned[]>();
  if (logins.length === 0) return byLogin;

  const live = await getEnabledModuleIds();
  const keyFns: ((login: string) => string)[] = [];
  if (live.has("quiz")) keyFns.push(quizAnswersKey);
  if (live.has("classic")) keyFns.push(classicSolvesKey);
  if (live.has("ai")) keyFns.push(aiSolvesKey);
  if (keyFns.length === 0) return byLogin;

  const commands = keyFns.flatMap((keyFn) => logins.map((login) => ["HGETALL", keyFn(login)]));
  let replies: { result?: unknown; error?: string }[];
  try {
    replies = await upstashPipeline(commands);
  } catch (err) {
    // The chart loses its module events; the board keeps its numbers. Failing
    // the whole page over a cosmetic overlay would be the wrong direction.
    console.error("module series unavailable:", err);
    return byLogin;
  }

  keyFns.forEach((_, moduleIndex) => {
    logins.forEach((login, loginIndex) => {
      const events = readEvents(replies[moduleIndex * logins.length + loginIndex]);
      if (events.length === 0) return;
      const existing = byLogin.get(login);
      if (existing) existing.push(...events);
      else byLogin.set(login, [...events]);
    });
  });
  return byLogin;
}

/** Merges scoring events into an existing cumulative series.
 *
 *  The source's series is already cumulative — each point is a running total,
 *  not a delta — so its steps are turned back into deltas before the module
 *  events join them, and the whole lot is re-accumulated in time order.
 *  Appending module points to the end instead would draw a line that disagrees
 *  with itself in the middle, where the tooltip reads the step under it. */
function mergeCumulative(existing: readonly SeriesPoint[], earned: readonly Earned[]): SeriesPoint[] {
  const deltas: { t: number; points: number }[] = [];

  let previous = 0;
  for (const point of [...existing].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) {
    const at = Date.parse(point.t);
    if (!Number.isFinite(at)) continue;
    deltas.push({ t: at, points: point.score - previous });
    previous = point.score;
  }
  for (const event of earned) deltas.push({ t: Date.parse(event.at), points: event.points });

  deltas.sort((a, b) => a.t - b.t);

  const series: SeriesPoint[] = [];
  let running = 0;
  for (const delta of deltas) {
    running += delta.points;
    const t = new Date(delta.t).toISOString();
    // Two events at one instant are one step, not two: the chart draws a step
    // per point, and a pair sharing an x renders as a vertical artefact.
    const last = series[series.length - 1];
    if (last && last.t === t) last.score = running;
    else series.push({ t, score: running });
  }
  return series;
}

/** Union of a team's members' events, deduped by item keeping the EARLIEST.
 *
 *  The rule the team totals already use (`foldTeamAnswers` keeps the earliest
 *  correct answer for a question more than one member holds). Summing members'
 *  events instead would re-introduce the double-count those totals avoid, and
 *  the line would end above the number in the team's own row. */
function foldTeamEvents(members: readonly string[], byLogin: Map<string, Earned[]>): Earned[] {
  const earliest = new Map<string, Earned>();
  for (const member of members) {
    for (const event of byLogin.get(member.toLowerCase()) ?? []) {
      const held = earliest.get(event.itemId);
      if (!held || Date.parse(event.at) < Date.parse(held.at)) earliest.set(event.itemId, event);
    }
  }
  return [...earliest.values()];
}

export async function withModuleSeries(data: LeaderboardData): Promise<LeaderboardData> {
  // Every login the board carries, which is the population the chart draws: it
  // plots every series handed to it, so computing a subset would silently drop
  // lines it draws today. Team members join even when they hold no entry of
  // their own, or their team's line would miss the items only they hold.
  const logins = new Set<string>();
  for (const entry of data.entries) logins.add(entry.login.toLowerCase());
  for (const team of data.teams) for (const member of team.members) logins.add(member.toLowerCase());
  if (logins.size === 0) return data;

  const byLogin = await readModuleEvents([...logins]);
  if (byLogin.size === 0) return data;

  const seriesByLogin = new Map((data.series ?? []).map((s) => [s.login.toLowerCase(), s]));
  const series: PlayerSeries[] = [...logins].map((login) => {
    const existing = seriesByLogin.get(login);
    return {
      login: existing?.login ?? login,
      points: mergeCumulative(existing?.points ?? [], byLogin.get(login) ?? []),
    };
  });

  const teamSeriesBySlug = new Map((data.teamSeries ?? []).map((s) => [s.slug, s]));
  const teamSeries: TeamSeries[] = data.teams.map((team) => {
    const existing = teamSeriesBySlug.get(team.slug);
    return {
      slug: team.slug,
      name: existing?.name ?? team.name,
      points: mergeCumulative(existing?.points ?? [], foldTeamEvents(team.members, byLogin)),
    };
  });

  return { ...data, series, teamSeries };
}
