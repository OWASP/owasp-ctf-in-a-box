// Observation helpers for the Discord announcer (#590). Pure and
// dependency-free: given snapshots of the event's public state, they say
// WHAT changed, whether a claim is due, and what a message should describe.
// Every effectful decision (claiming, posting, retrying) lives in
// announce/store.ts and announce/ticker.ts on top of these.

import { outsideScoringWindow, isLaunched } from "@/lib/schedule-window";

// --- lifecycle state ---------------------------------------------------------

/** The two lifecycle facts the announcer observes: launched, and scoring
 *  paused. */
export type LifecycleSnapshot = {
  launched: boolean;
  paused: boolean;
};

/** The stored pack: `v1|L<0|1>P<0|1>`. Compact, diffable in logs without
 *  carrying anything sensitive, and version-prefixed so a future shape change
 *  reads as "unknown" rather than being misparsed. */
export function encodeLifecycleState(s: LifecycleSnapshot): string {
  return `v1|L${s.launched ? 1 : 0}P${s.paused ? 1 : 0}`;
}

/** Parses the stored lifecycle pack; any other shape (or a missing value)
 *  reads as "no previous state", so a first tick announces nothing. */
export function decodeLifecycleState(raw: string | null | undefined): LifecycleSnapshot | null {
  if (typeof raw !== "string") return null;
  const m = /^v1\|L([01])P([01])$/.exec(raw);
  if (!m) return null;
  return { launched: m[1] === "1", paused: m[2] === "1" };
}

/** The lifecycle transitions to announce, as edge pairs (prev → next). Order
 *  matters only in that `launch` is announced before `pause` when an event
 *  launches already-paused. */
export type LifecycleEdge =
  | { kind: "launch"; prev: LifecycleSnapshot; next: LifecycleSnapshot }
  | { kind: "pause"; prev: LifecycleSnapshot; next: LifecycleSnapshot }
  | { kind: "resume"; prev: LifecycleSnapshot; next: LifecycleSnapshot };

/** The transitions between two lifecycle snapshots, in announcement order.
 *  A missing previous snapshot is read as all-off, so nothing fires on the
 *  very first observation. */
export function lifecycleEdges(prev: LifecycleSnapshot | null, next: LifecycleSnapshot): LifecycleEdge[] {
  const before = prev ?? { launched: false, paused: false };
  const edges: LifecycleEdge[] = [];
  if (!before.launched && next.launched) edges.push({ kind: "launch", prev: before, next });
  if (!before.paused && next.paused && next.launched) edges.push({ kind: "pause", prev: before, next });
  // `before.launched` is required: a pre-launch snapshot reads "paused"
  // (the scoring window has not opened), so a plain pause→resume test would
  // announce a phantom "resumed" alongside every launch. Only a pause that
  // was observed WHILE live, followed by a resume while still live, is a
  // resume.
  if (before.paused && !next.paused && before.launched && next.launched) edges.push({ kind: "resume", prev: before, next });
  return edges;
}

/** Derives the lifecycle snapshot from the settings the announcer already
 *  reads each tick. `paused` deliberately EXCLUDES "not launched": an event
 *  that has not started reads launched=false, paused=false — a pre-launch
 *  "paused" would pair with every launch into a phantom resume edge (see
 *  lifecycleEdges). A live event whose scoring window has not opened or has
 *  passed reads paused=true, same as a manual pause. */
export function lifecycleSnapshotFrom(
  settings: {
    scoringStartsAt: string | null;
    scoringEndsAt: string | null;
    paused: boolean;
  },
  nowMs: number,
): LifecycleSnapshot {
  const launched = isLaunched(nowMs, settings.scoringStartsAt);
  return {
    launched,
    paused: settings.paused || (launched && outsideScoringWindow(nowMs, settings.scoringStartsAt, settings.scoringEndsAt)),
  };
}

// --- remaining-time marks ----------------------------------------------------

/** The claim key for one mark on one scoring-close window. Keyed by the
 *  close instant AND the mark, so moving Scoring closes re-arms the marks
 *  for the new window (the old keys simply never match the new instant). */
export function markKey(endsAtMs: number, markMs: number): string {
  return `${endsAtMs}:${markMs}`;
}

/** Whether `markMs` of scoring-close lies in the announbable band at
 *  `nowMs`: remaining has reached the mark, but scoring is not over yet.
 *  The ledger claim (`ctf:announce:milestone`) makes it fire at most once. */
export function markCrossed(nowMs: number, endsAtMs: number, markMs: number): boolean {
  if (!Number.isFinite(endsAtMs) || endsAtMs <= nowMs) return false;
  return endsAtMs - nowMs <= markMs;
}

/** "1h 30m" style remaining-time label; null when there is no close. */
export function formatTimeLeft(nowMs: number, endsAtMs: number | null): string | null {
  if (endsAtMs === null || !Number.isFinite(endsAtMs)) return null;
  const delta = Math.max(0, endsAtMs - nowMs);
  const totalMin = Math.round(delta / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const min = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${min}m`;
  return `${min}m`;
}

// --- first-blood ledger fields ----------------------------------------------

/** The ledger field for one challenge: `<module>:<id>`. Modules namespace
 *  their ids so a classic `web-1` and an ai `web-1` never collide. */
export function challengeField(module: string, id: string): string {
  return `${module}:${id}`;
}
