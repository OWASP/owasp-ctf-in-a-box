// The event's time zone (#547): one IANA zone every date the event shows is
// formatted in — the hero's dates line, the phase line, the score chart's
// axis and the /admin schedule inputs. Storage never changes: bounds stay ISO
// instants, so the scorer and sync (which only compare instants) are
// untouched. Pure and client-safe — Intl only, no dependency, no
// `server-only` — because the admin Event tab converts its inputs in the
// browser.

export const DEFAULT_EVENT_TIME_ZONE = "UTC";

/** The zone as the organizer typed it, case-fixed ("utc" -> "UTC",
 *  "europe/madrid" -> "Europe/Madrid"), or null when this runtime does not
 *  know it. Not Intl's resolved ID: V8 resolves to legacy ICU names
 *  ("America/Argentina/Buenos_Aires" -> "America/Buenos_Aires"), and
 *  storing a spelling the organizer never typed reads as a bug. */
export function canonicalTimeZone(zone: string): string | null {
  if (!zone) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved === "UTC") return "UTC";
  const lower = zone.toLowerCase();
  return Intl.supportedValuesOf("timeZone").find((z) => z.toLowerCase() === lower) ?? zone;
}

/** A stored zone, or UTC when it is absent or no longer recognised — a
 *  display read never throws over a bad setting. */
export function resolveTimeZone(zone: string | null | undefined): string {
  return (zone && canonicalTimeZone(zone)) || DEFAULT_EVENT_TIME_ZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone });
    formatters.set(key, f);
  }
  return f;
}

function toMs(at: string | number | Date): number {
  return typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : at.getTime();
}

/** One instant on the event's wall clock, in en-US wording. */
export function formatInZone(at: string | number | Date, zone: string, opts: Intl.DateTimeFormatOptions): string {
  return formatter(zone, opts).format(toMs(at));
}

/** "UTC" for UTC, else the offset in force at that instant ("GMT-3"), so a
 *  daylight-saving zone is labelled right in both seasons. */
export function zoneLabel(zone: string, at: number): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const part = formatter(zone, { timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

function wallAt(ms: number, zone: string): Wall {
  const parts = formatter(zone, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ms);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour"), mi: n("minute") };
}

/** The zone's offset from UTC at an instant, in ms (GMT-3 -> -3h). */
function offsetAt(ms: number, zone: string): number {
  const w = wallAt(ms, zone);
  const floored = Math.floor(ms / 60_000) * 60_000;
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - floored;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as a datetime-local value on the event's clock, or "". */
export function instantToWall(iso: string | null, zone: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const w = wallAt(ms, zone);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A datetime-local value read on the event's clock, as an ISO instant, or
 *  null. A time inside a spring-forward gap lands on the instant the clock
 *  shows an hour later — the browser's own rule for a local time. */
export function wallToInstant(wall: string, zone: string): string | null {
  const m = WALL_RE.exec(wall);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  if (!Number.isFinite(guess)) return null;
  const first = guess - offsetAt(guess, zone);
  const second = guess - offsetAt(first, zone);
  // Near a transition the two estimates can disagree: keep the one that
  // reads back as the typed wall time. Only inside a spring-forward gap does
  // neither — then take the later, moving the time forward rather than back.
  const typed = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  const roundTrips = (ms: number) => instantToWall(new Date(ms).toISOString(), zone) === typed;
  const pick = roundTrips(first) ? first : roundTrips(second) ? second : Math.max(first, second);
  return new Date(pick).toISOString();
}
