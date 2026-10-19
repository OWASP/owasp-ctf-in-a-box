// The announcer's observation loop (#590). Started once per server
// instance from instrumentation.ts (nodejs runtime only), fire-and-forget,
// unref'd — it must never hold a serverless instance open or gate a request.
//
// Each tick, in order (every step is independently try/caught so one
// failure cannot skip the rest):
//
//   1. read config: no webhook, or no switch on, ends the tick right there —
//      an unconfigured or fully opted-out box does exactly ONE Redis read per
//      tick, and no observation work at all. While the box stays in that
//      state the loop BACKS OFF to a much longer interval (one config read
//      per backoff period instead of per 30s — an idle box must not hammer
//      Redis from every process); a configured tick restores the normal
//      interval, and a config read that FAILS keeps the current one — a
//      Redis blip is not evidence that the box is off. The config is
//      re-read every tick, so a /admin change takes effect on the next pass
//      with no restart; the config and webhook routes also nudge the loop to
//      run that pass immediately, so an opt-in moments before launch still
//      seeds the PRE-launch baseline and the launch edge is announced
//      instead of being swallowed by a first-observation seed.
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
//   4. remaining-time marks (only while the switch is on, and only while
//      the event is LAUNCHED and NOT paused/closed — the same
//      launched / not-paused / inside-window state detect.ts derives, so a
//      pre-launch close time or a manual freeze never posts "time
//      remaining"): claim every crossed mark in one pipeline, post at most
//      one time check — a restart, a duplicate tick or a mid-event enable
//      never bursts.
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

/** The interval while the announcer is configured and armed. 30s: lifecycle
 *  edges land within half a minute of the change without hammering Redis. */
export const ANNOUNCE_TICK_MS = 30_000;

/** The backoff interval while the box is unconfigured or fully opted-out:
 *  one config read per backoff period is enough to notice an /admin save,
 *  and an idle box should not pay a Redis read every 30s per process. */
export const ANNOUNCE_IDLE_TICK_MS = 5 * 60_000;

/** What a tick learned about the announcer's state, so the loop can pick the
 *  next interval: "active" = configured and armed (normal interval), "idle"
 *  = unconfigured or all-off (backoff), "unknown" = the tick could not tell
 *  (an overlapping tick, or a config read that failed) — keep the current
 *  interval; a blip must not back off a configured box. */
export type TickCadence = "active" | "idle" | "unknown";

/** The loop's process-wide state. It lives on `globalThis` because Next
 *  bundles instrumentation separately from route handlers: a module-local
 *  singleton in the admin route's copy would not be the loop instrumentation
 *  started, and a nudge would begin a SECOND loop instead of waking the
 *  existing one. The key is namespaced so a dev reload shares the one loop. */
type TickerState = {
  /** Guard against overlapping ticks (a slow Redis must not stack runs). */
  ticking: boolean;
  started: boolean;
  /** The pending timeout, so a nudge can replace it instead of running a
   *  second chain alongside it. */
  nextTick: ReturnType<typeof setTimeout> | null;
  /** A nudge that arrived mid-tick: run again as soon as it finishes. */
  pendingNudge: boolean;
  /** The last cadence a tick could prove. The boot default is ACTIVE, not
   *  the backoff: if the first config read fails, a configured box keeps
   *  retrying every 30s instead of waiting five minutes to find out it was
   *  armed. The first successful read settles the interval either way. */
  lastCadence: TickCadence;
};

const TICKER_STATE_KEY = "__ctfAnnounceTicker";

function tickerState(): TickerState {
  const holder = globalThis as typeof globalThis & { [TICKER_STATE_KEY]?: TickerState };
  return (holder[TICKER_STATE_KEY] ??= {
    ticking: false,
    started: false,
    nextTick: null,
    pendingNudge: false,
    lastCadence: "active",
  });
}

/** One observation pass. Exported for tests, which pass a fixed `nowMs`.
 *  Returns the cadence the next interval should follow. */
export async function runAnnounceTick(nowMs: number = Date.now()): Promise<TickCadence> {
  const state = tickerState();
  if (state.ticking) return "unknown";
  state.ticking = true;
  // The cadence this tick can PROVE: only a successful config read sets it,
  // so a failure anywhere later still reports the armed/unarmed state the
  // read established.
  let cadence: TickCadence = "unknown";
  try {
    let config: DiscordFullConfig;
    try {
      config = await getAnnounceConfig();
    } catch (err) {
      // A failed READ is not "all off" (a NOAUTH or a blip must not disable
      // a configured announcer, nor back its loop off): skip the tick and
      // keep the current cadence.
      console.error("[announce] config read failed, skipping tick:", errorLabel(err));
      return "unknown";
    }
    // The whole pass is opt-in: nothing configured (or every switch off) is
    // a single config read and done — no settings, no state CAS, no outbox
    // sweep. This is the box's default state until an organizer opts in.
    const armed = config.webhookConfigured && ANNOUNCEMENT_KINDS.some((kind) => kindEnabled(config, kind));
    cadence = armed ? "active" : "idle";
    if (!armed) return cadence;

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
    return cadence;
  } catch (err) {
    console.error("[announce] tick failed:", errorLabel(err));
    return cadence;
  } finally {
    state.ticking = false;
  }
}

/** Starts the loop once per process. Called from instrumentation.ts in the
 *  nodejs runtime; a no-op when Redis env is absent (a quiz box with no
 *  REST credentials has nothing to observe) or when already started. The
 *  loop is a self-scheduling timeout, not an interval, so the next delay can
 *  follow the last tick's cadence (backed off while idle). */
export function startAnnounceTicker(): void {
  const state = tickerState();
  if (state.started) return;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  state.started = true;
  // A first observation soon after boot picks up edges that happened while
  // the box was down (the CAS makes the catch-up announce once, not twice).
  scheduleTick(3_000);
}

/** Runs an observation pass NOW after an /admin config save, instead of
 *  waiting out the current timer. The immediate pass is what lets a webhook
 *  enabled shortly before launch record the pre-launch baseline, so the
 *  launch itself is an announced edge rather than a silent first-observation
 *  seed. Safe to call from a request: it only schedules work and never
 *  awaits Redis. No-op when the loop is not running (no Redis env), since
 *  there is nothing to observe. */
export function nudgeAnnounceTicker(): void {
  // A save can arrive before the boot timer ran (or after a failed start):
  // start it now, then replace its first delay with an immediate pass.
  const state = tickerState();
  if (!state.started) startAnnounceTicker();
  if (!state.started) return;
  if (state.ticking) {
    state.pendingNudge = true;
    return;
  }
  if (state.nextTick) {
    clearTimeout(state.nextTick);
    state.nextTick = null;
  }
  void tickAndReschedule();
}

/** Schedules the next pass, replacing any pending one so the loop stays a
 *  single chain. Unref'd: it must never pin a process open. */
function scheduleTick(delayMs: number): void {
  const state = tickerState();
  if (state.nextTick) clearTimeout(state.nextTick);
  state.nextTick = setTimeout(() => {
    state.nextTick = null;
    void tickAndReschedule();
  }, delayMs);
  state.nextTick.unref?.();
}

/** One tick, then schedule the next on that tick's cadence. */
async function tickAndReschedule(): Promise<void> {
  const state = tickerState();
  const cadence = await runAnnounceTick();
  if (cadence !== "unknown") state.lastCadence = cadence;
  if (state.pendingNudge) {
    state.pendingNudge = false;
    return tickAndReschedule();
  }
  scheduleTick(state.lastCadence === "active" ? ANNOUNCE_TICK_MS : ANNOUNCE_IDLE_TICK_MS);
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
 *  per-tick Redis work at the single config read.
 *
 *  The whole pass is gated on the event being LAUNCHED and NOT paused/closed
 *  — the same snapshot detect.ts derives for the lifecycle pass. A close
 *  time with no scoring start (not launched, ADR 59) must never post "Time
 *  remaining" for an event that never opened, and a manual freeze (or a
 *  passed window) silences the marks for as long as it holds. Claims are
 *  per-mark HSETNXs, so marks crossed while paused simply stay unclaimed: a
 *  resume posts at most ONE check (the current time left) on the next tick,
 *  late but truthful, never a burst of the marks the pause swallowed. */
async function tickMilestones(config: DiscordFullConfig, settings: AdminSettings, nowMs: number): Promise<void> {
  try {
    const snap = lifecycleSnapshotFrom(
      {
        scoringStartsAt: settings.scoringStartsAt,
        scoringEndsAt: settings.scoringEndsAt,
        paused: settings.paused,
      },
      nowMs,
    );
    if (!snap.launched || snap.paused || snap.closed) return;
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
