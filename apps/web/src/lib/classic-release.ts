// Whether a Jeopardy challenge is on the board for contestants right now.
// Pure and client-safe (no `server-only`, no store import): the board, the
// challenge page, the board-items API, the profile, the leaderboard's
// denominators and the admin status chip all ask this one function, so a
// hidden challenge cannot be absent from one surface and present on another.
//
// Hidden means "does not exist" on the contestant side. The grading and hint
// scripts make the same decision in Lua (CLASSIC_HIDDEN_LUA in
// classic-keys.ts) from the stored record, so a hand-made request cannot get
// past what the pages leave out.

import { formatInZone, zoneLabel } from "@/lib/event-time";

/** The visibility fields a stored challenge carries. `enabled` absent means
 *  live: every record written before the field existed stays on the board.
 *  `releaseAt` (an ISO instant) releases a disabled challenge on its own:
 *  evaluated at read time, with nothing scheduled on the box. */
export type ReleaseFields = { enabled?: boolean; releaseAt?: string | null };

/** What the admin list shows for a challenge. */
export type ChallengeStatus = { kind: "live" } | { kind: "disabled" } | { kind: "scheduled"; releaseAt: string };

/** The challenge's state at `nowMs` (epoch ms, the reader's clock). Visible
 *  iff it is enabled, or its release instant has come: `nowMs >= releaseAt`,
 *  so the instant itself is released. An unreadable release time is no
 *  release time. */
export function challengeStatus(c: ReleaseFields, nowMs: number): ChallengeStatus {
  if (c.enabled !== false) return { kind: "live" };
  const releaseMs = typeof c.releaseAt === "string" ? Date.parse(c.releaseAt) : NaN;
  if (!Number.isFinite(releaseMs)) return { kind: "disabled" };
  return nowMs >= releaseMs ? { kind: "live" } : { kind: "scheduled", releaseAt: c.releaseAt as string };
}

/** Whether contestants may see the challenge at `nowMs`. */
export function isChallengeVisible(c: ReleaseFields, nowMs: number): boolean {
  return challengeStatus(c, nowMs).kind === "live";
}

/** The visible subset of `list`, order kept. */
export function visibleChallenges<T extends ReleaseFields>(list: readonly T[], nowMs: number): T[] {
  return list.filter((c) => isChallengeVisible(c, nowMs));
}

const RELEASE_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** Whether `value` is a release time this kit accepts: an ISO 8601 date and
 *  time that says which zone it is in, ending in `Z` or an explicit `±HH:MM`
 *  offset. Without one, `Date.parse` reads it in the SERVER's zone, and the
 *  challenge would release at an instant nobody typed. The date and time must
 *  also exist: each part is checked against what the parsed instant reads
 *  back as, so a "Feb 30" or a "25:00" that `Date` would roll over to another
 *  day is refused rather than moved. Every boundary that takes a release time
 *  (the bundle parser, the admin route, the store, the editor) asks this. */
export function isReleaseInstant(value: string): boolean {
  const m = RELEASE_INSTANT_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s = "00", zone, oh, om] = m;
  if (zone !== "Z" && (Number(oh) > 23 || Number(om) > 59)) return false;
  // The wall time as typed, read as UTC: its parts must survive the trip.
  const wall = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  const parts = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()];
  if (parts.join() !== [y, mo, d, h, mi, s].map(Number).join()) return false;
  return Number.isFinite(Date.parse(value));
}

/** A release instant as an organizer reads it: the event's clock, its offset
 *  named ("Oct 8, 10:00 GMT-3"), so nobody has to guess whose 10:00 it is. */
export function releaseLabel(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const wall = formatInZone(ms, zone, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${wall} ${zoneLabel(zone, ms)}`;
}

/** `visibleChallenges` on the reader's own clock: what a page read uses. The
 *  graders decide by Redis's clock instead (CLASSIC_HIDDEN_LUA). */
export function visibleNow<T extends ReleaseFields>(list: readonly T[]): T[] {
  return visibleChallenges(list, Date.now());
}
