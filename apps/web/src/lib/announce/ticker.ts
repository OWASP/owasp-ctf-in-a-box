// The announcer's 30-second observation loop (#590). Started once per server
// instance from instrumentation.ts (nodejs runtime only), fire-and-forget,
// unref'd — it must never hold a serverless instance open or gate a request.
//
// Each tick, in order (every step is independently try/caught so one
// failure cannot skip the rest):
//
//   1. read config + admin settings (plain pipeline reads — SAFE from a
//      timer; the ticker deliberately does NOT use getEnabledModuleIds /
//      getFoldedLeaderboard, whose React cache() awaits Next's connection()
//      and would throw outside a request scope — it re-derives the live
//      module set from the same inputs those use)
//   2. lifecycle CAS: derive the snapshot, atomically advance the observed
//      state, announce the edges this replica won
//   3. release sweep: claim every newly-public challenge (ALWAYS, even when
//      announcements are off — so enabling later never replays history),
//      enqueue only for claimed ones when the release switch is on; locked
//      story steps are filtered out before any claim
//   4. board CAS: watch the top of the board, atomically advance the
//      snapshot (ALWAYS, so enabling leaders later fires only on a real
//      change), enqueue the leader announcement when this replica won a
//      change AND the switch is on
//   5. remaining-time marks and the daily summary: claim-then-enqueue
//   6. outbox retry sweep + prune
//
// Nothing here ever logs a webhook URL or a message payload; failures go
// through errorLabel.

import "server-only";
import { errorLabel } from "@/lib/error-label";
import { getAdminSettings, type AdminSettings } from "@/lib/admin-store";
import { effectiveRegistrationOpen } from "@/lib/schedule-window";
import { defaultEnabledModules, secureDevAvailable } from "@/lib/module-defaults";
import { resolveTimeZone } from "@/lib/event-time";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { listChallenges, listStories, getClassicTotals, getTeamClassicTotalsBatch } from "@/lib/classic-store";
import { listQuestions, getQuizTotals, getTeamQuizTotalsBatch } from "@/lib/quiz-store";
import { listAiChallenges, getAiTotals, getTeamAiTotalsBatch } from "@/lib/ai-store";
import { listTeams } from "@/lib/team-store";
import { lambdaSource } from "@/lib/leaderboard/lambda";
import { upstashSource } from "@/lib/leaderboard/upstash";
import { mockSource } from "@/lib/leaderboard/mock";
import type { ModuleId } from "@/lib/modules";
import { kindEnabled } from "@/lib/discord-config";
import {
  boardChanged,
  dailyWallDue,
  decodeBoardSnapshot,
  decodeLifecycleState,
  encodeBoardSnapshot,
  encodeLifecycleState,
  eventLocalDay,
  formatDayLabel,
  formatTimeLeft,
  leaderFromBoard,
  lifecycleEdges,
  lifecycleSnapshotFrom,
  markCrossed,
  markKey,
  releaseField,
  selectReleasable,
  type BoardRow,
  type ReleasableItem,
} from "./detect";
import { buildDailyMessage, buildLifecycleMessage, buildLeaderMessage, buildReleaseMessage } from "./messages";
import { enqueueAnnouncement, flushRetries } from "./sender";
import {
  ANNOUNCE_BOARD_KEY,
  ANNOUNCE_DAILY_KEY,
  ANNOUNCE_DAILY_SNAPSHOT_KEY,
  ANNOUNCE_LIFECYCLE_KEY,
  ANNOUNCE_MILESTONE_KEY,
  ANNOUNCE_RELEASED_KEY,
} from "./keys";
import {
  claimLedgerField,
  claimLedgerFields,
  getAnnounceConfig,
  ledgerFields,
  outboxPrune,
  readStatePack,
  stateCompareSet,
} from "./store";
import { parseMarks, type DiscordFullConfig } from "@/lib/discord-config";
import { upstashPipeline } from "@/lib/upstash";

/** How many top-of-board rows the snapshot watches. `top3` scope reads the
 *  first three of these. */
const WATCH_DEPTH = 3;

/** The interval. 30s: lifecycle/release/leader edges land within half a
 *  minute of the change without hammering Redis from an idle box. */
export const ANNOUNCE_TICK_MS = 30_000;

/** Guard against overlapping ticks (a slow Redis must not stack runs). */
let ticking = false;
let started = false;

/** One observation pass. Exported for tests, which pass a fixed `nowMs`. */
export async function runAnnounceTick(nowMs: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const config = await getAnnounceConfig();
    // Nothing configured at all: the tick still CLAIMS (release/board
    // state), because an unclaimed challenge is a replay waiting to happen
    // the day the organizer enables announcements — but it never posts.
    let settings: AdminSettings | null = null;
    try {
      settings = await getAdminSettings();
    } catch (err) {
      // Without settings there is no lifecycle/board observation to make;
      // the release claim sweep below does not need them and still runs.
      console.error("[announce] settings read failed, skipping lifecycle/board:", errorLabel(err));
    }

    const live = liveModuleIds(settings);

    if (settings) await tickLifecycle(config, settings, nowMs);
    await tickReleases(config, live);
    if (settings) await tickBoard(config, live);
    if (settings) await tickDaily(config, live, settings, nowMs);
    if (settings) await tickMilestones(config, settings, nowMs);

    await outboxPrune(undefined, nowMs).catch(() => {});
    if (config.webhookConfigured) await flushRetries();
  } catch (err) {
    console.error("[announce] tick failed:", errorLabel(err));
  } finally {
    ticking = false;
  }
}

/** Starts the interval once per process. Called from instrumentation.ts in
 *  the nodejs runtime; a no-op when Redis env is absent (a quiz box with no
 *  REST credentials has nothing to observe) or when already started. */
export function startAnnounceTicker(): void {
  if (started) return;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  started = true;
  const timer = setInterval(() => {
    void runAnnounceTick();
  }, ANNOUNCE_TICK_MS);
  timer.unref?.();
  // A first observation soon after boot picks up edges that happened while
  // the box was down (the CAS makes the catch-up announce once, not twice).
  setTimeout(() => void runAnnounceTick(), 3_000).unref?.();
}

// --- helpers ----------------------------------------------------------------

/** Claim-only release sweep, for the webhook-save path: every currently
 *  public, non-locked challenge is claimed in the released ledger WITHOUT
 *  any post, so a webhook saved mid-event never replays the past. The
 *  ticker's own release pass runs the same claims every tick; this exists
 *  so a box whose ticker has not yet ticked (fresh boot, or a just-saved
 *  webhook) is still safe the moment the URL is stored. */
export async function seedReleaseClaims(): Promise<number> {
  const settings = await getAdminSettings().catch(() => null);
  const live = liveModuleIds(settings);
  const { items, stories } = await collectReleasable(live);
  const released = await ledgerFields(ANNOUNCE_RELEASED_KEY);
  const candidates = selectReleasable(items, stories, released);
  if (candidates.length === 0) return 0;
  const won = await claimLedgerFields(
    ANNOUNCE_RELEASED_KEY,
    candidates.map((item) => releaseField(item.module, item.id)),
  );
  return won.size;
}

/** The live module set, re-derived exactly like enabled-modules' own
 *  getEnabledModuleIds but WITHOUT its request-scoped cache()/connection().
 *  Stored set wins (including explicitly empty); the SCORE_IMAGE-derived
 *  default applies when nothing is stored; secure-development is dropped
 *  when this deployment has no scorer image. */
function liveModuleIds(settings: AdminSettings | null): ReadonlySet<ModuleId> {
  const resolved = new Set<ModuleId>(settings?.enabledModuleIds ?? defaultEnabledModules(process.env));
  if (!secureDevAvailable(process.env)) resolved.delete("secure-development");
  return resolved;
}

function eventName(settings: AdminSettings): string {
  const name = settings.eventIdentity.eventName;
  return name && name.trim() !== "" ? name : DEFAULT_EVENT_IDENTITY.eventName;
}

function timeZone(settings: AdminSettings): string {
  return resolveTimeZone(settings.eventIdentity.eventTimeZone);
}

async function tickLifecycle(config: DiscordFullConfig, settings: AdminSettings, nowMs: number): Promise<void> {
  try {
    const registrationOpen = effectiveRegistrationOpen(settings, nowMs);
    const snap = lifecycleSnapshotFrom(
      {
        scoringStartsAt: settings.scoringStartsAt,
        scoringEndsAt: settings.scoringEndsAt,
        paused: settings.paused,
        registrationOpen,
      },
      nowMs,
    );
    const next = encodeLifecycleState(snap);
    const expected = (await readStatePack(ANNOUNCE_LIFECYCLE_KEY)) ?? "";
    if (expected === next) return;
    const cas = await stateCompareSet(ANNOUNCE_LIFECYCLE_KEY, expected, next);
    if (cas.code !== 1) return; // 0 = someone else won or state moved on; 2 = silent init
    const prev = decodeLifecycleState(cas.prev);
    const name = eventName(settings);
    for (const edge of lifecycleEdges(prev, snap)) {
      if (!kindEnabled(config, edge.kind)) continue;
      await enqueueAnnouncement(edge.kind, buildLifecycleMessage({ kind: edge.kind, eventName: name }));
    }
  } catch (err) {
    console.error("[announce] lifecycle tick failed:", errorLabel(err));
  }
}

/** The public items of every live module. Quiz prompts are public (the
 *  board renders them); they carry the question's `prompt` as the title and
 *  a fixed "Quiz" category. */
async function collectReleasable(live: ReadonlySet<ModuleId>): Promise<{ items: ReleasableItem[]; stories: Awaited<ReturnType<typeof listStories>> }> {
  const [challenges, questions, aiChallenges, stories] = await Promise.all([
    live.has("classic") ? listChallenges().catch(() => []) : Promise.resolve([]),
    live.has("quiz") ? listQuestions().catch(() => []) : Promise.resolve([]),
    live.has("ai") ? listAiChallenges().catch(() => []) : Promise.resolve([]),
    live.has("classic") ? listStories().catch(() => []) : Promise.resolve([]),
  ]);
  const items: ReleasableItem[] = [
    ...challenges.map((c) => ({ module: "classic" as const, id: c.id, title: c.title, category: c.category, points: c.points })),
    ...questions.map((q) => ({ module: "quiz" as const, id: q.id, title: q.prompt, category: "Quiz", points: q.points })),
    ...aiChallenges.map((c) => ({ module: "ai" as const, id: c.id, title: c.title, category: c.category, points: c.points })),
  ];
  return { items, stories };
}

async function tickReleases(config: DiscordFullConfig, live: ReadonlySet<ModuleId>): Promise<void> {
  try {
    const { items, stories } = await collectReleasable(live);
    const released = await ledgerFields(ANNOUNCE_RELEASED_KEY);
    const candidates = selectReleasable(items, stories, released);
    if (candidates.length === 0) return;
    const won = await claimLedgerFields(
      ANNOUNCE_RELEASED_KEY,
      candidates.map((item) => releaseField(item.module, item.id)),
    );
    // The claim above runs whether or not posts are wanted — that is what
    // makes "enable announcements later" safe. Posting is the gated half.
    if (!config.webhookConfigured || !config.releases) return;
    const origin = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : "http://localhost";
    for (const item of candidates) {
      if (!won.has(releaseField(item.module, item.id))) continue;
      const url =
        item.module === "quiz" ? `${origin}/quiz` : `${origin}/${item.module === "classic" ? "flags" : "ai"}/${item.id}`;
      await enqueueAnnouncement(
        "release",
        buildReleaseMessage({ title: item.title, category: item.category, points: item.points, url }),
      );
    }
  } catch (err) {
    console.error("[announce] release tick failed:", errorLabel(err));
  }
}

/** Secure-development's contribution to the observed board, when a scorer
 *  image exists. Mirrors getLeaderboardSourceMode's env rule minus its
 *  isModuleLive check (the caller has already established secure-dev is
 *  live from the same settings snapshot). */
async function secureDevPoints(): Promise<{ teams: Map<string, number>; individuals: Map<string, number> } | null> {
  if (!secureDevAvailable(process.env)) return null;
  const mode = process.env.LEADERBOARD_SOURCE;
  const source = mode === "lambda" ? lambdaSource : mode === "upstash" ? upstashSource : mockSource;
  const data = await source.getLeaderboard();
  const teams = new Map<string, number>();
  const individuals = new Map<string, number>();
  if (data.capabilities.teams) for (const t of data.teams) teams.set(t.slug, t.points);
  for (const e of data.entries) individuals.set(e.login, e.points);
  return { teams, individuals };
}

/** The ticker's board observation: the same points the visible board shows,
 *  built only from connection-free reads (store totals + team batches +
 *  the secure-dev source when live). Rows with zero points are dropped —
 *  an empty board never announces. */
export async function observeBoardRows(live: ReadonlySet<ModuleId>, watchDepth: number = WATCH_DEPTH): Promise<BoardRow[]> {
  const [teams, sd] = await Promise.all([listTeams().catch(() => []), secureDevPoints().catch(() => null)]);

  if (teams.length > 0) {
    const members = teams.map((t) => t.members);
    const [classic, quiz, ai] = await Promise.all([
      live.has("classic") ? getTeamClassicTotalsBatch(members).catch(() => null) : Promise.resolve(null),
      live.has("quiz") ? getTeamQuizTotalsBatch(members).catch(() => null) : Promise.resolve(null),
      live.has("ai") ? getTeamAiTotalsBatch(members).catch(() => null) : Promise.resolve(null),
    ]);
    return teams
      .map((t, i) => ({
        slug: t.slug,
        name: t.name,
        points: (sd?.teams.get(t.slug) ?? 0) + (classic?.[i]?.points ?? 0) + (quiz?.[i]?.points ?? 0) + (ai?.[i]?.points ?? 0),
      }))
      .filter((r) => r.points > 0)
      .sort((a, b) => b.points - a.points || a.slug.localeCompare(b.slug))
      .slice(0, watchDepth);
  }

  const [classic, quiz, ai] = await Promise.all([
    live.has("classic") ? getClassicTotals().catch(() => new Map<string, { points: number }>()) : Promise.resolve(new Map<string, { points: number }>()),
    live.has("quiz") ? getQuizTotals().catch(() => new Map<string, { points: number }>()) : Promise.resolve(new Map<string, { points: number }>()),
    live.has("ai") ? getAiTotals().catch(() => new Map<string, { points: number }>()) : Promise.resolve(new Map<string, { points: number }>()),
  ]);
  const byLogin = new Map<string, number>(sd?.individuals ?? []);
  const add = (totals: Map<string, { points: number }>) => {
    for (const [login, t] of totals) byLogin.set(login, (byLogin.get(login) ?? 0) + t.points);
  };
  add(classic);
  add(quiz);
  add(ai);
  return [...byLogin.entries()]
    .filter(([, points]) => points > 0)
    .map(([login, points]) => ({ slug: login, name: login, points }))
    .sort((a, b) => b.points - a.points || a.slug.localeCompare(b.slug))
    .slice(0, watchDepth);
}

async function tickBoard(config: DiscordFullConfig, live: ReadonlySet<ModuleId>): Promise<void> {
  try {
    const current = await observeBoardRows(live);
    const next = encodeBoardSnapshot(current);
    const expected = (await readStatePack(ANNOUNCE_BOARD_KEY)) ?? "";
    if (expected === next) return;
    const cas = await stateCompareSet(ANNOUNCE_BOARD_KEY, expected, next);
    if (cas.code !== 1) return;
    const prev = decodeBoardSnapshot(cas.prev);
    if (!config.webhookConfigured || !config.leaders) return;
    if (!boardChanged(prev, current)) return;
    const leader = leaderFromBoard(current, config.leaderScope);
    if (!leader) return;
    await enqueueAnnouncement("leader", buildLeaderMessage({ scope: config.leaderScope, ...leader }));
  } catch (err) {
    console.error("[announce] board tick failed:", errorLabel(err));
  }
}

async function tickDaily(config: DiscordFullConfig, live: ReadonlySet<ModuleId>, settings: AdminSettings, nowMs: number): Promise<void> {
  try {
    if (!config.webhookConfigured || !config.daily) return;
    const zone = timeZone(settings);
    if (!dailyWallDue(nowMs, zone, config.dailyAt)) return;
    const day = eventLocalDay(nowMs, zone);
    const claimed = await claimLedgerField(ANNOUNCE_DAILY_KEY, day);
    if (!claimed) return;

    // Deltas since the last daily fire. A missing baseline (first fire ever)
    // seeds one and reports zeros — understated, never overstated (ADR 69).
    const [solves, releasedCount] = await Promise.all([
      totalSolved(live),
      ledgerFields(ANNOUNCE_RELEASED_KEY),
    ]);
    const prevSnapshot = await readDailySnapshot();
    const solvesDelta = prevSnapshot ? Math.max(0, solves - prevSnapshot.solves) : 0;
    const releasesDelta = prevSnapshot ? Math.max(0, releasedCount.size - prevSnapshot.released) : 0;
    await writeDailySnapshot({ solves, released: releasedCount.size, at: new Date(nowMs).toISOString() });

    const current = await observeBoardRows(live, config.dailyTopN);
    const endsAtMs = Date.parse(settings.scoringEndsAt ?? "");
    await enqueueAnnouncement(
      "daily",
      buildDailyMessage({
        day: formatDayLabel(day, zone),
        topTeams: current.map((r) => ({ name: r.name, points: r.points })),
        solves: solvesDelta,
        releases: releasesDelta,
        timeLeft: formatTimeLeft(nowMs, Number.isFinite(endsAtMs) ? endsAtMs : null),
      }),
    );
  } catch (err) {
    console.error("[announce] daily tick failed:", errorLabel(err));
  }
}

/** Solved-item count across live modules (individuals; the board is
 *  team-folded but the daily "solves" figure is about activity volume, and
 *  the per-login sums are the cheap, connection-free reading of it). */
async function totalSolved(live: ReadonlySet<ModuleId>): Promise<number> {
  let n = 0;
  try {
    if (live.has("classic")) for (const t of (await getClassicTotals()).values()) n += t.solved;
    if (live.has("quiz")) for (const t of (await getQuizTotals()).values()) n += t.answered;
    if (live.has("ai")) for (const t of (await getAiTotals()).values()) n += t.solved;
  } catch (err) {
    console.error("[announce] daily totals failed:", errorLabel(err));
  }
  return n;
}

type DailySnapshot = { solves: number; released: number; at: string };

async function readDailySnapshot(): Promise<DailySnapshot | null> {
  const [res] = await upstashPipeline([["GET", ANNOUNCE_DAILY_SNAPSHOT_KEY]]);
  if (res.error || typeof res.result !== "string") return null;
  try {
    const parsed = JSON.parse(res.result) as DailySnapshot;
    return typeof parsed === "object" && parsed !== null && Number.isFinite(parsed.solves) && Number.isFinite(parsed.released)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function writeDailySnapshot(snapshot: DailySnapshot): Promise<void> {
  const [res] = await upstashPipeline([["SET", ANNOUNCE_DAILY_SNAPSHOT_KEY, JSON.stringify(snapshot)]]);
  if (res.error) console.error("[announce] daily snapshot write failed:", errorLabel(new Error(res.error)));
}

async function tickMilestones(config: DiscordFullConfig, settings: AdminSettings, nowMs: number): Promise<void> {
  try {
    if (!config.webhookConfigured || !config.milestones) return;
    const endsAtMs = Date.parse(settings.scoringEndsAt ?? "");
    if (!Number.isFinite(endsAtMs)) return;
    const parsed = parseMarks(config.marks);
    if (!parsed.ok) return;
    const name = eventName(settings);
    for (const mark of parsed.marks) {
      if (!markCrossed(nowMs, endsAtMs, mark)) continue;
      const claimed = await claimLedgerField(ANNOUNCE_MILESTONE_KEY, markKey(endsAtMs, mark));
      if (!claimed) continue;
      await enqueueAnnouncement(
        "milestone",
        buildLifecycleMessage({ kind: "milestone", eventName: name, timeLeft: formatTimeLeft(nowMs, endsAtMs) ?? undefined }),
      );
    }
  } catch (err) {
    console.error("[announce] milestone tick failed:", errorLabel(err));
  }
}
