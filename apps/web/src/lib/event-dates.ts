// The event dates line, derived from two ISO instant bounds instead of the
// old event.yaml `dates:` free-text string. Pure and client-safe: no
// `server-only`, no `process.env`.
//
// Formatting is pinned to the EVENT's zone (#547; UTC when none is set),
// never the host's — deterministic under test wherever it runs, and the day
// printed is the event's calendar day, not UTC's.

import { DEFAULT_EVENT_TIME_ZONE, formatInZone } from "@/lib/event-time";

const FULL_DATE = { month: "short", day: "numeric", year: "numeric" } as const;
const MONTH_DAY = { month: "short", day: "numeric" } as const;

/** Parses an ISO instant, or returns `null` for a missing/unparseable one —
 *  a malformed bound is treated the same as an absent one rather than
 *  surfacing "Invalid Date" text. */
function parseInstant(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The dates line for the landing page / admin panel: "Oct 1, 2026" for a
 * single day, "Oct 1 – Oct 3, 2026" within one year, "Dec 31, 2026 – Jan 2,
 * 2027" across years, "From Oct 1, 2026" / "Until Oct 3, 2026" for an
 * open-ended bound, and "" when neither bound parses.
 */
export function formatDateRange(start: string | null, end: string | null, zone: string = DEFAULT_EVENT_TIME_ZONE): string {
  const startDate = parseInstant(start);
  const endDate = parseInstant(end);

  if (!startDate && !endDate) return "";
  if (startDate && !endDate) return `From ${formatInZone(startDate, zone, FULL_DATE)}`;
  if (!startDate && endDate) return `Until ${formatInZone(endDate, zone, FULL_DATE)}`;

  const startFull = formatInZone(startDate as Date, zone, FULL_DATE);
  const endFull = formatInZone(endDate as Date, zone, FULL_DATE);
  if (startFull === endFull) return startFull;

  const year = (d: Date) => formatInZone(d, zone, { year: "numeric" });
  const sameYear = year(startDate as Date) === year(endDate as Date);
  const startHalf = sameYear ? formatInZone(startDate as Date, zone, MONTH_DAY) : startFull;
  return `${startHalf} – ${endFull}`;
}
