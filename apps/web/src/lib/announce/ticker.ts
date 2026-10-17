// The announcer's 30-second observation loop (#590). Started once per server
// instance from instrumentation.ts (nodejs runtime only), fire-and-forget,
// unref'd — it must never hold a serverless instance open or gate a request.
//
// Each tick, in order (every step is independently try/caught so one
// failure cannot skip the rest):
//
//   1. read config: no webhook, or no switch on, ends the tick right there —
//      an unconfigured or fully opted-out box does exactly ONE Redis read per
//      tick, and no observation work at all. The config is re-read every
//      tick, so a /admin change takes effect on the next pass with no
//      restart.
//   2. read admin settings — only when a pass below can use them (the
//      lifecycle or marks switches are on). Plain pipeline reads, SAFE from
//      a timer: the ticker deliberately does NOT use getEnabledModuleIds /
//      getFoldedLeaderboard, whose React cache() awaits Next's connection()
//      and would throw outside a request scope.
//   3. lifecycle CAS (only while launch or pause is switched on): derive the
//      snapshot, atomically advance the observed state, announce the edges
//      this replica won. The state freezes while both are off — no CAS at
//      all — and a box with no stored observation yet (fresh boot,
//      post-reset) seeds silently, so nothing that predates the first
//      observation is ever announced.
//   4. remaining-time marks (only while the switch is on): claim every
//      crossed mark in one pipeline, post at most one time check — a
//      restart, a duplicate tick or a mid-event enable never bursts.
//   5. outbox prune + retry sweep
//
// Nothing here ever logs a webhook URL or a message payload; failures go
// through errorLabel.

import "server-only";
import { errorLabel } from "@/lib/error-label";
import { getAdminSettings, type AdminSettings } from "@/lib/admin-store";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { ANNOUNCEMENT_KINDS, kindEnabled, parseMarks, type DiscordFullConfig } from "@/lib/discord-config";
import {
  decodeLifecycleState,
  encodeLifecycleState,
  formatTimeLeft,
  lifecycleEdges,
  lifecycleSnapshotFrom,
  markCrossed,
  markKey,
} from "./detect";
import { buildLifecycleMessage } from "./messages";
import { enqueueAnnouncement, flushRetries } from "./sender";
import { ANNOUNCE_LIFECYCLE_KEY, ANNOUNCE_MILESTONE_KEY } from "./keys";
import { claimLedgerFields, getAnnounceConfig, outboxPrune, readStatePack, stateCompareSet } from "./store";

/** The interval. 30s: lifecycle edges land within half a minute of the
 *  change without hammering Redis from an idle box. */
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
    // The whole pass is opt-in: nothing configured (or every switch off) is
    // a single config read and done — no settings, no state CAS, no outbox
    // sweep. This is the box's default state until an organizer opts in.
    if (!config.webhookConfigured || !ANNOUNCEMENT_KINDS.some((kind) => kindEnabled(config, kind))) return;

    if (config.launch || config.pause || config.milestones) {
      let settings: AdminSettings | null = null;
      try {
        settings = await getAdminSettings();
      } catch (err) {
        // Without settings there is no lifecycle or marks observation to make;
        // the outbox sweeps below do not need them and still run.
        console.error("[announce] settings read failed, skipping lifecycle/milestones:", errorLabel(err));
      }
      if (settings) {
        if (config.launch || config.pause) await tickLifecycle(config, settings, nowMs);
        if (config.milestones) await tickMilestones(config, settings, nowMs);
      }
    }

    await outboxPrune(undefined, nowMs).catch(() => {});
    await flushRetries();
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

/** The event's display name, falling back to the kit default. */
function eventName(settings: AdminSettings): string {
  const name = settings.eventIdentity.eventName;
  return name && name.trim() !== "" ? name : DEFAULT_EVENT_IDENTITY.eventName;
}

/** Lifecycle observation: derive this tick's snapshot, atomically advance
 *  the stored one, and announce the edges this replica won — only for the
 *  kinds the config switches allow. The state advances while either
 *  lifecycle switch is on, so enabling the other later fires only on a real
 *  change it then watches. */
async function tickLifecycle(config: DiscordFullConfig, settings: AdminSettings, nowMs: number): Promise<void> {
  try {
    const snap = lifecycleSnapshotFrom(
      {
        scoringStartsAt: settings.scoringStartsAt,
        scoringEndsAt: settings.scoringEndsAt,
        paused: settings.paused,
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

/** Remaining-time marks, claim-first: every crossed mark is claimed on the
 *  tick that first sees it (all of them in one pipeline), and however many
 *  the gap swallowed the caller posts ONE time check carrying the current
 *  time left. That is what keeps a restart, a duplicate tick or a mid-event
 *  enable to at most one post instead of a burst of "1h left" / "15m left"
 *  checks. Claims run only while the switch is on and a webhook exists
 *  (runAnnounceTick gates this pass), so a box that never opted in keeps its
 *  per-tick Redis work at the single config read. */
async function tickMilestones(config: DiscordFullConfig, settings: AdminSettings, nowMs: number): Promise<void> {
  try {
    const endsAtMs = Date.parse(settings.scoringEndsAt ?? "");
    if (!Number.isFinite(endsAtMs)) return;
    const parsed = parseMarks(config.marks);
    if (!parsed.ok) return;
    const crossed = parsed.marks.filter((m) => markCrossed(nowMs, endsAtMs, m));
    if (crossed.length === 0) return;
    const won = await claimLedgerFields(ANNOUNCE_MILESTONE_KEY, crossed.map((m) => markKey(endsAtMs, m)));
    if (won.size === 0 || !config.webhookConfigured || !config.milestones) return;
    await enqueueAnnouncement(
      "milestone",
      buildLifecycleMessage({
        kind: "milestone",
        eventName: eventName(settings),
        timeLeft: formatTimeLeft(nowMs, endsAtMs) ?? undefined,
      }),
    );
  } catch (err) {
    console.error("[announce] milestone tick failed:", errorLabel(err));
  }
}
