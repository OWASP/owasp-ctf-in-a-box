// Key names and shared constants for the activity log (issue #212), split
// from activity-log.ts so the admin panel's Client Components can import the
// type vocabulary without dragging in `server-only`/Upstash — the same
// client-safety contract as classic-keys.ts and quiz-keys.ts (see their
// header comments). This file must stay dependency-free.

/** One Redis LIST of JSON entries, newest first (LPUSH). Trimmed to
 *  `ACTIVITY_LOG_MAX` on every write, so it is bounded by construction. */
export const ACTIVITY_LOG_KEY = "ctf:activity:log";

/** Newest entries kept. ~5k covers an event weekend comfortably; the oldest
 *  silently drop, which is the retention policy — see issue #212. */
export const ACTIVITY_LOG_MAX = 5000;

/** Event types the log records today. Ordered for the admin filter strip.
 *
 *  A reader (the admin tab) must tolerate types that are not in this list:
 *  the log outlives deploys in both directions, so entries written by a
 *  newer or older build than the one reading them are expected, not
 *  corruption. */
export const ACTIVITY_TYPES = [
  "login",
  "quiz-solve",
  "classic-solve",
  "team-create",
  "team-join",
  "team-leave",
  "team-rename",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];
