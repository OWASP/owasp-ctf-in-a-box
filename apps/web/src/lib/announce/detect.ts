// Observation helpers for the Discord announcer (#590). Pure and
// dependency-free: given snapshots of the event's public state, they say
// WHAT changed, whether a claim is due, and what a message should describe.
// Every effectful decision (claiming, posting, retrying) lives in
// announce/store.ts and announce/ticker.ts on top of these.

import { outsideScoringWindow, isLaunched, scoringEnded } from "@/lib/schedule-window";

// --- lifecycle state ---------------------------------------------------------

/** The lifecycle facts the announcer observes: launched, scoring paused
 *  (a manual freeze, or the window not yet open), and closed — the scheduled
 *  scoring END has passed. `closed` is NOT a pause: nothing resumes after it,
 *  so it is kept distinct rather than being folded into `paused`. A manual
 *  freeze keeps `paused` TRUE even while `closed` — the pause is a real fact
 *  that survives the close and a later window extension.
 *
 *  `announced` says whether the held pause was the one the channel was told
 *  about while live, so lifting it owes a "resumed" post. A pause that begins
 *  while closed is never announced (nothing live is paused), so it stays
 *  false and its eventual lift posts nothing — which is what keeps a
 *  close → freeze → extend → unfreeze sequence from announcing a resume with
 *  no pause before it. */
export type LifecycleSnapshot = {
  launched: boolean;
  paused: boolean;
  closed: boolean;
  announced: boolean;
};

/** The stored pack: `v2|L<0|1>P<0|1>C<0|1>A<0|1>`. Compact and diffable in
 *  logs without carrying anything sensitive; an unknown shape reads as
 *  unknown, so the state seeds silently rather than being misparsed. */
export function encodeLifecycleState(s: LifecycleSnapshot): string {
  return `v2|L${s.launched ? 1 : 0}P${s.paused ? 1 : 0}C${s.closed ? 1 : 0}A${s.announced ? 1 : 0}`;
}

/** Parses the stored lifecycle pack; any other shape (or a missing value)
 *  reads as "no previous state", so a first tick announces nothing. */
export function decodeLifecycleState(raw: string | null | undefined): LifecycleSnapshot | null {
  if (typeof raw !== "string") return null;
  const m = /^v2\|L([01])P([01])C([01])A([01])$/.exec(raw);
  if (!m) return null;
  return { launched: m[1] === "1", paused: m[2] === "1", closed: m[3] === "1", announced: m[4] === "1" };
}

/** Whether the state to STORE carries an announced pause. Carried forward for
 *  a pause that is still held, and across an unfreeze while the window is
 *  closed (so the reopen still owes exactly one resume); set only when a
 *  pause edge fires — live, or at launch for an event that starts already
 *  paused — never for a pause born while closed. A missing previous state
 *  (first observation, post-reset, or an unknown stored shape) reads as
 *  false: nothing predating the first observation is announced. */
export function announcedLifecyclePause(prev: LifecycleSnapshot | null, next: LifecycleSnapshot): boolean {
  if (!next.paused) {
    // An unfreeze can arrive while the window is still closed. Keep the
    // announced bit so the resume is owed when the window reopens; on that
    // reopen `next.closed` is false and the bit clears.
    return Boolean(prev?.announced && next.closed);
  }
  if (!prev) return false;
  if (prev.paused && prev.announced) return true;
  if (!next.launched || next.closed) return false;
  // Launching already paused is a pause edge even though `prev.paused` was
  // already true: the pre-launch hold was never announced, so the launch is
  // the first moment it can be.
  if (!prev.launched) return true;
  return !prev.paused;
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
 *  very first observation. Entering (or leaving) the `closed` state is
 *  deliberately NOT an edge: the channel must never be told scoring "is
 *  paused — submits are on hold until it resumes" at the window's end, and a
 *  window the admin later extends must not announce a phantom "resumed".
 *  A pause while `closed` is not an edge either (next.closed suppresses it);
 *  because the real paused bit is carried across the close, a later
 *  extension reopens the same hold without re-announcing the freeze.
 *  An event that launches already paused gets BOTH edges, launch first: the
 *  hold is only announceable once the event is live. */
export function lifecycleEdges(prev: LifecycleSnapshot | null, next: LifecycleSnapshot): LifecycleEdge[] {
  const before = prev ?? { launched: false, paused: false, closed: false, announced: false };
  const edges: LifecycleEdge[] = [];
  if (!before.launched && next.launched) edges.push({ kind: "launch", prev: before, next });
  // `!before.launched` is the launch-while-paused case: the pre-launch hold
  // becomes announceable at launch even though the paused bit was already set.
  if (next.paused && next.launched && !next.closed && (!before.paused || !before.launched)) {
    edges.push({ kind: "pause", prev: before, next });
  }
  // Only a pause the channel was actually told about owes a resume —
  // `before.announced` carries across an unfreeze while the window is closed,
  // so the reopen posts exactly one resume even though the paused bit is
  // already clear. `next.launched` keeps a pre-launch baseline from pairing
  // with the launch into a phantom resume; a pause born while closed is
  // silent, so lifting it after a window extension posts nothing.
  if (before.announced && !next.paused && !next.closed && next.launched) {
    edges.push({ kind: "resume", prev: before, next });
  }
  return edges;
}

/** Derives the lifecycle snapshot from the settings the announcer already
 *  reads each tick. `paused` deliberately EXCLUDES "not launched": an event
 *  that has not started reads launched=false, and a pre-launch "paused"
 *  would pair with every launch into a phantom resume edge (see
 *  lifecycleEdges). A live event whose scoring window has not opened reads
 *  paused=true, same as a manual pause. A PASSED window end is `closed`, not
 *  paused (nothing resumes after the end), but a manual freeze is preserved
 *  across the close — the real paused bit survives so a later extension
 *  cannot mistake the same freeze for a fresh one. `announced` is always
 *  false here: it is derived from the previous STORED state, not the
 *  settings, by `announcedLifecyclePause`. */
export function lifecycleSnapshotFrom(
  settings: {
    scoringStartsAt: string | null;
    scoringEndsAt: string | null;
    paused: boolean;
  },
  nowMs: number,
): LifecycleSnapshot {
  const launched = isLaunched(nowMs, settings.scoringStartsAt);
  const closed = scoringEnded(nowMs, settings.scoringEndsAt);
  return {
    launched,
    closed,
    announced: false,
    paused:
      settings.paused ||
      (launched && !closed && outsideScoringWindow(nowMs, settings.scoringStartsAt, settings.scoringEndsAt)),
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
