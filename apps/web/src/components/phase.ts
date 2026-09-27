// Pure phase-resolution logic, deliberately dependency-free — no
// admin-store, no `"server-only"`. Split out of phase-line.tsx (which stays
// the Server Component reading `getAdminSettings()` for the public phase
// strip) because the admin Overview screen needs the SAME phase and boundary
// wording, computed from `settings` state a Client Component already holds
// in memory after a toggle — importing phase-line.tsx directly there would
// drag its `admin-store` import (guarded by `"server-only"`) into client
// code and crash at build/runtime. This is the same split
// `lib/schedule-window.ts` makes for `outsideWindow`, for the same reason.

import { outsideScoringWindow } from "@/lib/schedule-window";

export type EventPhase = "registration" | "live" | "frozen" | "results";

export type PhaseResolution = {
  phase: EventPhase;
  startsAt: string | null;
  endsAt: string | null;
};

/** not launched > results > manual freeze > before start > scheduled gap > live. */
export function phaseFromSettings(
  s: { paused: boolean; scoringStartsAt: string | null; scoringEndsAt: string | null },
  now: number = Date.now(),
): PhaseResolution {
  const start = s.scoringStartsAt ? Date.parse(s.scoringStartsAt) : NaN;
  const end = s.scoringEndsAt ? Date.parse(s.scoringEndsAt) : NaN;
  let phase: EventPhase;
  // No (or an unparseable) scoring start = not launched (#464): the
  // pre-launch lobby, FIRST — an event that never launched has no results,
  // whatever its end date says, and a freeze means nothing before launch.
  if (!Number.isFinite(start)) phase = "registration";
  else if (Number.isFinite(end) && now > end) phase = "results";
  else if (s.paused) phase = "frozen";
  else if (now < start) phase = "registration";
  else if (outsideScoringWindow(now, s.scoringStartsAt, s.scoringEndsAt)) phase = "frozen";
  else phase = "live";
  return { phase, startsAt: s.scoringStartsAt, endsAt: s.scoringEndsAt };
}

/** The current phase's node/chip color: green while scoring runs, amber for
 *  a freeze, brand blue for the lobby, paper for the final state. */
export const PHASE_COLOR: Record<EventPhase, string> = {
  registration: "#2563eb",
  live: "#22c55e",
  frozen: "#d4a017",
  results: "#d4d4d8", // --foreground: the event's final, settled state
};

/** UTC pinned explicitly: whatever the box's clock renders is what every
 *  visitor sees — an unlabeled local time would just be UTC wearing no
 *  badge. Saying "UTC" makes it honest. */
function fmt(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** One boundary time, attached to the CURRENT phase — the moment a visitor
 *  would actually plan around. A manual freeze has no known end, so it makes
 *  no promise (`null`). */
export function phaseBoundaryLabel(phase: EventPhase, startsAt: string | null, endsAt: string | null): string | null {
  return phase === "registration" && fmt(startsAt)
    ? `scoring opens ${fmt(startsAt)} UTC`
    : phase === "live" && fmt(endsAt)
      ? `until ${fmt(endsAt)} UTC`
      : phase === "results" && fmt(endsAt)
        ? `ended ${fmt(endsAt)} UTC`
        : null;
}
