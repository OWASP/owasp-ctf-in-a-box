// Observation helpers for the Discord announcer (#590). Pure and
// dependency-free: given snapshots of the event's public state, they say
// WHAT changed, whether a claim is due, and what a message should describe.
// Every effectful decision (claiming, posting, retrying) lives in
// announce/store.ts and announce/ticker.ts on top of these.

import { outsideScoringWindow, isLaunched } from "@/lib/schedule-window";
import { storyPositions, type Story } from "@/lib/story-lock";

// --- lifecycle state ---------------------------------------------------------

/** The three lifecycle facts the announcer observes: launched, scoring
 *  paused, and registration closed. `registration` is the EFFECTIVE state
 *  (manual toggle AND window) so the announcement fires when the last open
 *  reason goes away. */
export type LifecycleSnapshot = {
  launched: boolean;
  paused: boolean;
  registrationClosed: boolean;
};

/** The stored pack: `v1|L<0|1>P<0|1>R<0|1>`. Compact, diffable in logs
 *  without carrying anything sensitive, and version-prefixed so a future
 *  shape change reads as "unknown" rather than being misparsed. */
export function encodeLifecycleState(s: LifecycleSnapshot): string {
  return `v1|L${s.launched ? 1 : 0}P${s.paused ? 1 : 0}R${s.registrationClosed ? 1 : 0}`;
}

/** Parses the stored lifecycle pack; any other shape (or a missing value)
 *  reads as "no previous state", so a first tick announces nothing. */
export function decodeLifecycleState(raw: string | null | undefined): LifecycleSnapshot | null {
  if (typeof raw !== "string") return null;
  const m = /^v1\|L([01])P([01])R([01])$/.exec(raw);
  if (!m) return null;
  return { launched: m[1] === "1", paused: m[2] === "1", registrationClosed: m[3] === "1" };
}

/** The lifecycle transitions to announce, as edge pairs
 *  (prev → next). Order matters only in that `launch` is announced before
 *  `pause` when an event launches already-paused. `registration-closed` is
 *  edge-triggered: closing fires it once, reopening is silent. */
export type LifecycleEdge =
  | { kind: "launch"; prev: LifecycleSnapshot; next: LifecycleSnapshot }
  | { kind: "pause"; prev: LifecycleSnapshot; next: LifecycleSnapshot }
  | { kind: "resume"; prev: LifecycleSnapshot; next: LifecycleSnapshot }
  | { kind: "registration-closed"; prev: LifecycleSnapshot; next: LifecycleSnapshot };

/** The transitions between two lifecycle snapshots, in announcement order.
 *  A missing previous snapshot is read as all-off, so nothing fires on the
 *  very first observation. */
export function lifecycleEdges(prev: LifecycleSnapshot | null, next: LifecycleSnapshot): LifecycleEdge[] {
  const before = prev ?? { launched: false, paused: false, registrationClosed: false };
  const edges: LifecycleEdge[] = [];
  if (!before.launched && next.launched) edges.push({ kind: "launch", prev: before, next });
  if (!before.paused && next.paused && next.launched) edges.push({ kind: "pause", prev: before, next });
  // `before.launched` is required: a pre-launch snapshot reads "paused"
  // (the scoring window has not opened), so a plain pause→resume test would
  // announce a phantom "resumed" alongside every launch. Only a pause that
  // was observed WHILE live, followed by a resume while still live, is a
  // resume.
  if (before.paused && !next.paused && before.launched && next.launched) edges.push({ kind: "resume", prev: before, next });
  // `before.launched` is required, on this edge for the same reason it is on
  // resume: the null baseline IS the pre-launch baseline, so an event that
  // launches already-closed gets its launch announced and nothing piled on
  // top of it — the closed edge is only claimed when we watched a LIVE event
  // close. Closing fires once, reopening is silent.
  if (before.launched && !before.registrationClosed && next.registrationClosed && next.launched) {
    edges.push({ kind: "registration-closed", prev: before, next });
  }
  return edges;
}

/** Derives the lifecycle snapshot from the settings the announcer already
 *  reads each tick. `registrationOpen` is the EFFECTIVE value (schedule-
 *  window's effectiveRegistrationOpen), so this stays a pure function of
 *  what it is handed. `paused` deliberately EXCLUDES "not launched": an
 *  event that has not started reads launched=false, paused=false — a
 *  pre-launch "paused" would pair with every launch into a phantom resume
 *  edge (see lifecycleEdges). A live event whose scoring window has not
 *  opened or has passed reads paused=true, same as a manual pause. */
export function lifecycleSnapshotFrom(
  settings: {
    scoringStartsAt: string | null;
    scoringEndsAt: string | null;
    paused: boolean;
    registrationOpen: boolean;
  },
  nowMs: number,
): LifecycleSnapshot {
  const launched = isLaunched(nowMs, settings.scoringStartsAt);
  return {
    launched,
    paused: settings.paused || (launched && outsideScoringWindow(nowMs, settings.scoringStartsAt, settings.scoringEndsAt)),
    registrationClosed: !settings.registrationOpen,
  };
}

// --- leaderboard observation -------------------------------------------------

export type BoardRow = { slug: string; name: string; points: number };

/** The snapshot, as stored: `slug:points` per row, `;`-joined, capped at the
 *  watch depth. Ordering is significant (rank order) and part of the
 *  comparison: a rank swap among the top is a change. */
export function encodeBoardSnapshot(rows: readonly BoardRow[]): string {
  return rows.map((r) => `${r.slug}:${r.points}`).join(";");
}

/** Parses the stored board pack; a missing value reads as "no board yet"
 *  (an empty list) rather than a malformed one. */
export function decodeBoardSnapshot(raw: string | null | undefined): BoardRow[] | null {
  if (typeof raw !== "string" || raw === "") return [];
  return raw.split(";").map((part) => {
    const i = part.lastIndexOf(":");
    const slug = i >= 0 ? part.slice(0, i) : part;
    const points = i >= 0 ? Number(part.slice(i + 1)) : 0;
    return { slug, name: slug, points: Number.isFinite(points) ? points : 0 };
  });
}

/** Whether the watched board changed. Empty current rows (no scores yet)
 *  never count as a change — an empty board announcing itself would be the
 *  daily summary's job, not a rank change's. */
export function boardChanged(prev: BoardRow[] | null, current: readonly BoardRow[]): boolean {
  if (current.length === 0) return false;
  if (!prev || prev.length === 0) return true;
  return encodeBoardSnapshot(prev) !== encodeBoardSnapshot(current);
}

/** The leader-announcement payload derived from the current board. */
export function leaderFromBoard(
  current: readonly BoardRow[],
  scope: "first" | "top3",
): { leader: { name: string; points: number }; runnersUp: { name: string; points: number }[] } | null {
  const leader = current[0];
  if (!leader) return null;
  return {
    leader: { name: leader.name, points: leader.points },
    runnersUp: scope === "top3" ? current.slice(1, 3).map((r) => ({ name: r.name, points: r.points })) : [],
  };
}

// --- daily summary -----------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The event-local calendar day a given instant falls on, in the event's
 *  timezone: `YYYY-MM-DD`, the ledger's claim key. DST-safe via Intl. */
export function eventLocalDay(nowMs: number, timeZone: string): string {
  // en-CA renders as YYYY-MM-DD, which is exactly the claim format.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}

/** Type guard for a stored `YYYY-MM-DD` day claim key. */
export function isEventLocalDay(raw: unknown): raw is string {
  return typeof raw === "string" && DAY_RE.test(raw);
}

/** A friendly label for a `YYYY-MM-DD` day on the event's clock. */
export function formatDayLabel(day: string, timeZone: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(ms));
}

/** Whether `nowMs` has passed today's `dailyAt` (HH:MM on the event's
 *  clock). The daily claim ledger does the one-per-day discipline; this only
 *  says the local wall time has arrived. */
export function dailyWallDue(nowMs: number, timeZone: string, dailyAt: string): boolean {
  const wall = wallClockMinutes(nowMs, timeZone);
  const [h, m] = dailyAt.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  return wall >= h * 60 + m;
}

/** Minutes since local midnight, on the event's clock. */
export function wallClockMinutes(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
  const [h, m] = parts.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
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

// --- challenge releases ------------------------------------------------------

/** One publicly-visible item the release sweep can announce. Built by the
 *  ticker from the module stores' PUBLIC list shapes — never from an
 *  admin record. */
export type ReleasableItem = {
  module: "classic" | "quiz" | "ai";
  id: string;
  title: string;
  category: string;
  points: number;
};

/** Selects the items whose release should be ANNOUNCED (claimed and posted):
 *  every public item not already in the released ledger, EXCEPT locked story
 *  steps — a challenge nobody can open yet is not released. Step 1 of every
 *  story is always open, so it passes through. */
export function selectReleasable(
  items: readonly ReleasableItem[],
  stories: readonly Story[],
  released: ReadonlySet<string>,
): ReleasableItem[] {
  const positions = storyPositions(stories, new Set(items.map((i) => i.id)));
  return items.filter((item) => {
    if (released.has(releaseField(item.module, item.id))) return false;
    const pos = positions.get(item.id);
    return !pos || pos.position === 1;
  });
}

/** The ledger field for one challenge: `<module>:<id>`. Modules namespace
 *  their ids so a classic `web-1` and an ai `web-1` never collide. */
export function releaseField(module: string, id: string): string {
  return `${module}:${id}`;
}
