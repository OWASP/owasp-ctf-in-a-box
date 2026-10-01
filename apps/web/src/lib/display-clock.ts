// The projector board's clock (#543 P2): one line of text from the scoring
// window, ticked client-side by display-clock.tsx. Pure and dependency-light
// so every state is unit-tested. It reads the window through the SAME rule
// the scorers apply (schedule-window.ts): no — or an unparseable — start
// means the event is not launched (#464), and the end instant itself is
// still inside the window.

import { outsideScoringWindow } from "@/lib/schedule-window";

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** "02:14:07" under a day; "3d 04h" from a day out (seconds there would
 *  just be noise on a wall read from across the room). */
function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (ms >= DAY_MS) {
    const d = Math.floor(total / 86_400);
    const h = Math.floor((total % 86_400) / 3600);
    return `${d}d ${pad(h)}h`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** `not launched` · `starts in …` · `ends in …` · `` (live, no end) · `final`. */
export function clockText(nowMs: number, startsAt: string | null, endsAt: string | null): string {
  const s = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(s)) return "not launched";
  if (nowMs < s) return `starts in ${span(s - nowMs)}`;
  const e = endsAt ? Date.parse(endsAt) : NaN;
  if (outsideScoringWindow(nowMs, startsAt, endsAt)) return Number.isFinite(e) ? "final" : "";
  return Number.isFinite(e) ? `ends in ${span(e - nowMs)}` : "";
}
