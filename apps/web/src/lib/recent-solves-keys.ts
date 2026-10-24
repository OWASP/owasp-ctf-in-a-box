// Shared vocabulary for the projector board's recent-solves feed (#542).
// Dependency-free on purpose, like activity-keys.ts and classic-keys.ts: the
// display component imports the types and labels without pulling in
// `server-only` or Upstash.

/** Newest-first sorted set of recent solve ids (score = solve epoch ms). */
export const RECENT_SOLVES_KEY = "ctf:feed:recent-solves";

/** Hash of solve id -> the stored public event. Split from the sorted set so
 *  an event can be identified (and therefore deduplicated) by team + item
 *  while its display data still carries the team name from solve time. */
export const RECENT_SOLVES_DATA_KEY = "ctf:feed:recent-solves:data";

/** How many events the sorted set (and its data hash) retains. The response
 *  only returns `RECENT_SOLVES_LIMIT`. Bounded on every write. */
export const RECENT_SOLVES_MAX = 50;

/** How many lines the projector shows. */
export const RECENT_SOLVES_LIMIT = 5;

export type RecentSolveModule = "classic" | "quiz" | "ai" | "secure-development";

/** What the public route and the projector receive. Deliberately has nowhere
 *  to put a login, an internal challenge id, an app id, or an activity type:
 *  the server builds it field by field from the stored event plus the
 *  currently public challenge metadata. */
export type RecentSolveItem = {
  team: string;
  title: string;
  module: RecentSolveModule;
  points: number;
  /** Solve time, ISO. */
  at: string;
};

export const RECENT_SOLVE_MODULE_LABELS: Record<RecentSolveModule, string> = {
  classic: "Classic",
  quiz: "Quiz",
  ai: "AI",
  "secure-development": "Secure Dev",
};
