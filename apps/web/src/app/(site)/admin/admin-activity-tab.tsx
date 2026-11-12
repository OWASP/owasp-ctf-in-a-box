"use client";

// The admin activity log (issue #212): who signed in, who solved what, and
// team changes, newest first, from GET /api/admin/activity.
//
// Loaded when this becomes the active destination, not on mount, like
// Insights: an organizer opening the sidebar to reach Support shouldn't pay
// a Redis read for a panel they aren't looking at. While the event phase is
// live it then refreshes itself every 15 s (use-live-poll.ts), with the
// stamp beside the count saying how old the read is; the Refresh button is
// the same code path for an organizer who won't wait.
//
// Filters (type chips, a search over every field, a time range) are
// CLIENT-SIDE — the route serves raw offset pages by design (see its header
// comment). While one is on, the rest of the log is paged in so the search
// covers all of it, and the count line says how far it has got, so "3 of 200
// loaded" is never mistaken for "3 in total".

import { useEffect, useMemo, useRef, useState } from "react";
import { ACTIVITY_TYPES } from "@/lib/activity-keys";
import { adminTime, DEFAULT_EVENT_TIME_ZONE, wallToInstant } from "@/lib/event-time";
import AdminLiveStamp from "./admin-live-stamp";
import { MODULE_LABEL } from "./vocabulary";
import { LIVE_POLL_MS, useLivePoll } from "./use-live-poll";
import { activityZone, UtcToggle, useShowUtc } from "./activity-time-zone";

export type ActivityEntry = { at: string; type: string; userId: string; name: string; detail?: string };

const PAGE_SIZE = 200;
const FIELD_CLASS =
  "rounded-md border border-white/10 bg-[#12121e] px-2.5 py-1 text-sm text-white placeholder:text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
/** The route's own cap on `limit` (src/app/api/admin/activity/route.ts). */
const LIMIT_MAX = 500;

/** How many rows a refresh re-reads from the top: at least a page, and as
 *  many as the organizer has paged in (up to the route's cap), so a timed
 *  refresh never silently drops the older rows they scrolled down to.
 *  Exported for direct testing. */
export function refreshLimit(loaded: number): number {
  return Math.min(LIMIT_MAX, Math.max(PAGE_SIZE, loaded));
}

const entryKey = (e: ActivityEntry) => `${e.at}\u0000${e.type}\u0000${e.userId}\u0000${e.detail ?? ""}`;

/** What a refresh from the top leaves on screen. The fresh page replaces
 *  everything it covers; rows the organizer had loaded that it did NOT reach
 *  are kept, minus any the fresh page already holds. That tail exists past
 *  the route's cap (one request cannot re-read 600 rows) and also whenever
 *  new events arrived since the last read — they push the oldest loaded row
 *  out of a same-sized page, so the decision is never "same length, nothing
 *  to keep". The one case nothing old is kept: the server says the whole log
 *  fits in the page (`total` ≤ its length — a master reset, say), so a
 *  shrunken log is not padded with rows that no longer exist. Exported for
 *  direct testing. */
export function mergeRefresh(fresh: ActivityEntry[], prev: ActivityEntry[] | null, total: number): ActivityEntry[] {
  if (!prev || total <= fresh.length) return fresh;
  const seen = new Set(fresh.map(entryKey));
  return [...fresh, ...prev.filter((e) => !seen.has(entryKey(e)))];
}

/** Human labels for the known types. Unknown types (an entry written by a
 *  newer or older build than this one) render their raw type string rather
 *  than being dropped — the log must never silently hide events. */
export const TYPE_LABELS: Record<string, string> = {
  login: "signed in",
  // Each solve is named for the module whose tab an organizer would open to
  // find it, which is that module's registry name (vocabulary.ts, audit F25).
  // A classic solve read "flag solve" under a tab called Classic CTF; an ai
  // solve read "ai solve", the raw id.
  "quiz-solve": `${MODULE_LABEL.quiz} solve`,
  "classic-solve": `${MODULE_LABEL.classic} solve`,
  "ai-solve": `${MODULE_LABEL.ai} solve`,
  "team-create": "created team",
  "team-join": "joined team",
  "team-leave": "left team",
  "team-rename": "renamed team",
};

/** Compact row timestamp on the event's clock, "08-24 15:03:27 GMT-3" — see
 *  `adminTime`. Every row on the panel reads in one zone, and the full
 *  instant stays on hover via `title`. */
export function formatWhen(iso: string, zone: string): string {
  return adminTime(iso, zone);
}

/** What the panel narrows the log by: the type chip, the search box, the
 *  clock its times read on (the search matches the time AS SHOWN), and an
 *  optional time range in epoch ms. */
export type ActivityQuery = {
  type: string | null;
  text: string;
  zone: string;
  since?: number | null;
  until?: number | null;
};

type Field = "any" | "player" | "type" | "detail" | "team";
const FIELDS: readonly Field[] = ["player", "type", "detail", "team"];

/** The search box's words, lowercased. `player:`, `type:`, `detail:` and
 *  `team:` restrict a word to that field; a prefix with nothing after it is
 *  dropped rather than matching everything or nothing. */
function parseSearch(text: string): { field: Field; needle: string }[] {
  const terms: { field: Field; needle: string }[] = [];
  for (const word of text.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    const colon = word.indexOf(":");
    const prefix = colon > 0 ? (word.slice(0, colon) as Field) : null;
    if (prefix && FIELDS.includes(prefix)) {
      const needle = word.slice(colon + 1);
      if (needle) terms.push({ field: prefix, needle });
    } else {
      terms.push({ field: "any", needle: word });
    }
  }
  return terms;
}

function matchesTerm(e: ActivityEntry, field: Field, needle: string, zone: string): boolean {
  const has = (value: string | undefined) => !!value && value.toLowerCase().includes(needle);
  const typeText = `${e.type} ${TYPE_LABELS[e.type] ?? ""}`;
  switch (field) {
    case "player":
      return has(e.name);
    case "type":
      return has(typeText);
    case "detail":
      return has(e.detail);
    case "team":
      return e.type.startsWith("team-") && has(e.detail);
    default:
      return has(e.name) || has(typeText) || has(e.detail) || has(formatWhen(e.at, zone));
  }
}

function inRange(e: ActivityEntry, since?: number | null, until?: number | null): boolean {
  if (since == null && until == null) return true;
  const at = Date.parse(e.at);
  if (Number.isNaN(at)) return false;
  return (since == null || at >= since) && (until == null || at <= until);
}

/** The client-side filter the panel applies to the log. Exported for direct
 *  testing — filter logic behind a useState toggle is invisible to a static
 *  render. Every word in the box must match somewhere in the row (player name, the
 *  type's id or label, the detail, or the time as displayed on the panel's
 *  clock), case-insensitively and as a substring: an organizer chasing
 *  "did dcote… solve crypto" types fragments, not exact values. */
export function filterEntries(entries: ActivityEntry[], query: ActivityQuery): ActivityEntry[] {
  const terms = parseSearch(query.text);
  return entries.filter(
    (e) =>
      (!query.type || e.type === query.type) &&
      inRange(e, query.since, query.until) &&
      terms.every((t) => matchesTerm(e, t.field, t.needle, query.zone)),
  );
}

/** Rows per type within the current search and range, ignoring the type
 *  chip itself, so each chip says what selecting it would show. */
export function typeCounts(entries: ActivityEntry[], query: ActivityQuery): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of filterEntries(entries, { ...query, type: null })) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

export const RANGE_PICKS = ["all", "15m", "1h", "6h", "24h"] as const;
export type RangePick = (typeof RANGE_PICKS)[number];
const RANGE_MS: Record<Exclude<RangePick, "all">, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
};

/** A quick pick's lower bound against `now`; "all" has none. */
export function rangeSince(pick: RangePick, now: number): number | null {
  return pick === "all" ? null : now - RANGE_MS[pick];
}

const RANGE_LABEL: Record<RangePick, string> = {
  all: "any time",
  "15m": "last 15 min",
  "1h": "last hour",
  "6h": "last 6 h",
  "24h": "last 24 h",
};

/** The search box's text from a location's query string (`?q=`). */
export function searchFromUrl(search: string): string {
  return new URLSearchParams(search).get("q") ?? "";
}

/** `href` with `?q=` set to the search, or removed when the box is empty,
 *  every other parameter (the `?tab=` deep link) kept. */
export function urlWithSearch(href: string, text: string): string {
  const url = new URL(href, "http://x");
  if (text.trim()) url.searchParams.set("q", text.trim());
  else url.searchParams.delete("q");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The URL's search on first render in the browser; "" on the server. The
 *  box only renders once a load lands, client-side, so the two never have
 *  to agree during hydration. */
function initialSearch(): string {
  return typeof window === "undefined" ? "" : searchFromUrl(window.location.search);
}

export default function AdminActivityTab({
  visible = false,
  live = false,
  zone = DEFAULT_EVENT_TIME_ZONE,
}: {
  /** This is the active destination — gates the first load and the loop.
   *  Optional so a static render (the tests) fetches nothing. */
  visible?: boolean;
  /** The event phase is live (components/phase.ts) — gates the loop. */
  live?: boolean;
  /** The event's resolved time zone; row times read on its clock. */
  zone?: string;
}) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [showUtc, setShowUtc] = useShowUtc();
  const rowZone = activityZone(zone, showUtc);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [rangePick, setRangePick] = useState<RangePick>("all");
  // When the quick pick was chosen: "last hour" counts back from the newer of
  // that and the last read, so a live panel's window moves with each refresh.
  const [pickedAt, setPickedAt] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Every request takes a ticket; a response whose ticket is no longer the
  // newest is dropped. "Load more" and a timed refresh can otherwise be in
  // flight together (the poll loop's in-flight guard covers only its own
  // requests), and whichever landed last would overwrite the other's rows.
  const reqSeq = useRef(0);

  /** `fresh` reloads from the top (the newest events — also the refresh
   *  semantics); otherwise appends the next page after what's loaded. `all`
   *  keeps paging until the whole log is in, for a search: it covers every
   *  entry, not just the pages loaded (at most ACTIVITY_LOG_MAX short rows,
   *  which is why filtering stays client-side at all). Resolves to whether
   *  the rows on screen were replaced — false on an error, a superseded
   *  response, or a request the poll loop withdrew (`signal`, see
   *  use-live-poll.ts) — so the stamp's age stays honest. */
  async function load(fresh: boolean, limit = PAGE_SIZE, signal?: AbortSignal, all = false): Promise<boolean> {
    const seq = ++reqSeq.current;
    setPending(true);
    setError(null);
    try {
      let offset = fresh ? 0 : (entries?.length ?? 0);
      let pageLimit = limit;
      const rows: ActivityEntry[] = [];
      let count = 0;
      for (;;) {
        const res = await fetch(`/api/admin/activity?offset=${offset}&limit=${pageLimit}`, { signal });
        const data = (await res.json().catch(() => ({}))) as {
          entries?: ActivityEntry[];
          total?: number;
          error?: string;
        };
        if (seq !== reqSeq.current || signal?.aborted) return false;
        if (!res.ok || !Array.isArray(data.entries)) {
          setError(data.error ?? "Could not load the activity log");
          return false;
        }
        rows.push(...data.entries);
        count = data.total ?? 0;
        offset += data.entries.length;
        if (!all || data.entries.length === 0 || offset >= count) break;
        pageLimit = LIMIT_MAX;
      }
      setEntries((prev) => (fresh ? mergeRefresh(rows, prev, count) : [...(prev ?? []), ...rows]));
      setTotal(count);
      return true;
    } catch {
      if (seq === reqSeq.current && !signal?.aborted) setError("Could not load the activity log");
      return false;
    } finally {
      if (seq === reqSeq.current) setPending(false);
    }
  }

  const loaded = entries?.length ?? 0;
  // Any filter control in use. Decided before the poll, which reads the whole
  // log while it is true (a shared `?q=` link opened cold included).
  const narrowing = typeFilter !== null || search.trim() !== "" || rangePick !== "all" || from !== "" || to !== "";
  /** A filter control just changed: page in the rest of the log, once. */
  const searchAll = () => {
    if (entries && loaded < total && !pending) void load(true, LIMIT_MAX, undefined, true);
  };

  // The poll loop and the Refresh button share this: a fresh read from the
  // top, wide enough to keep every row already paged in.
  const { updatedAt, refresh } = useLivePoll({
    visible,
    live,
    intervalMs: LIVE_POLL_MS,
    load: (signal) => load(true, refreshLimit(loaded), signal, narrowing),
  });

  // A typed from/to wins over the quick pick; both read on the panel's clock.
  const fromMs = from ? Date.parse(wallToInstant(from, rowZone) ?? "") : NaN;
  const toMs = to ? Date.parse(wallToInstant(to, rowZone) ?? "") : NaN;
  const since = Number.isFinite(fromMs) ? fromMs : rangeSince(rangePick, Math.max(pickedAt, updatedAt ?? 0));
  const until = Number.isFinite(toMs) ? toMs : null;
  const query: ActivityQuery = useMemo(
    () => ({ type: typeFilter, text: search, zone: rowZone, since, until }),
    [typeFilter, search, rowZone, since, until],
  );
  const shown = useMemo(() => (entries ? filterEntries(entries, query) : []), [entries, query]);
  const counts = useMemo(() => (entries ? typeCounts(entries, query) : {}), [entries, query]);
  const filtered = typeFilter !== null || search.trim() !== "" || since != null || until != null;

  // The search rides in the URL, so a filtered view survives a refresh and
  // can be handed to another organizer.
  useEffect(() => {
    if (!visible) return;
    const next = urlWithSearch(window.location.pathname + window.location.search + window.location.hash, search);
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [search, visible]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* Primary (filled) only while there is nothing on screen yet — once
            the log is showing and refreshing itself, the button is the
            secondary "now, please", not the way the screen works. */}
        <button
          type="button"
          disabled={pending}
          onClick={() => void refresh()}
          className={
            entries
              ? "flex-none rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white disabled:opacity-50"
              : "flex-none rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50"
          }
        >
          {pending ? "Loading…" : entries ? "Refresh" : "Load activity"}
        </button>
        {entries && (
          <span className="text-sm text-muted">
            {filtered
              ? loaded < total
                ? `${shown.length} matching so far, searching ${loaded} of ${total}…`
                : `${shown.length} matching, searched all ${total}`
              : `${loaded} of ${total} loaded, newest first`}
          </span>
        )}
        <AdminLiveStamp updatedAt={updatedAt} live={live} intervalMs={LIVE_POLL_MS} />
        <UtcToggle checked={showUtc} onChange={setShowUtc} />
      </div>

      {!entries && !error && (
        <p className="text-sm text-muted">
          Sign-ins, solves, and team changes, newest first. Entries name the challenge or team
          involved — never a flag or an answer.
        </p>
      )}

      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}

      {entries && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTypeFilter(null)}
              aria-pressed={typeFilter === null}
              className={
                typeFilter === null
                  ? "rounded-full border border-[#2563eb]/70 px-2.5 py-1 text-xs text-white"
                  : "rounded-full border border-white/10 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
              }
            >
              all
            </button>
            {ACTIVITY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTypeFilter(typeFilter === t ? null : t);
                  searchAll();
                }}
                aria-pressed={typeFilter === t}
                className={
                  typeFilter === t
                    ? "rounded-full border border-[#2563eb]/70 px-2.5 py-1 text-xs text-white"
                    : "rounded-full border border-white/10 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                }
              >
                {TYPE_LABELS[t] ?? t} <span className="tabular-nums text-muted">{counts[t] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label="Search the activity log"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                searchAll();
              }}
              placeholder="search player, event, detail, time · player: type: detail: team:"
              className={`min-w-0 flex-1 basis-64 ${FIELD_CLASS}`}
            />
            <select
              aria-label="Time range"
              value={rangePick}
              onChange={(e) => {
                setRangePick(e.target.value as RangePick);
                setPickedAt(Date.now());
                searchAll();
              }}
              className={FIELD_CLASS}
            >
              {RANGE_PICKS.map((p) => (
                <option key={p} value={p}>
                  {RANGE_LABEL[p]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-muted">
              from
              <input
                type="datetime-local"
                aria-label="From"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  searchAll();
                }}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              to
              <input
                type="datetime-local"
                aria-label="To"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  searchAll();
                }}
                className={FIELD_CLASS}
              />
            </label>
          </div>

          {shown.length === 0 ? (
            <p className="text-sm text-muted">
              {filtered
                ? loaded < total
                  ? "Nothing matches yet; still searching."
                  : "Nothing in the log matches."
                : "Nothing recorded yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead className="text-muted">
                  <tr className="border-b border-white/[0.06] text-left">
                    <th className="py-1 pr-3 font-medium">When</th>
                    <th className="py-1 pr-3 font-medium">Event</th>
                    <th className="py-1 pr-3 font-medium">Who</th>
                    <th className="py-1 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  {shown.map((e, i) => (
                    <tr key={`${e.at}-${e.type}-${e.userId}-${i}`} className="border-b border-white/[0.03]">
                      <td className="py-1 pr-3 font-mono tabular-nums text-muted" title={e.at}>
                        {formatWhen(e.at, rowZone)}
                      </td>
                      <td className="py-1 pr-3">{TYPE_LABELS[e.type] ?? e.type}</td>
                      <td className="py-1 pr-3 font-mono text-white">{e.name}</td>
                      <td className="py-1 font-mono text-muted">{e.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {loaded < total && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void load(false)}
              className="self-start rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white disabled:opacity-50"
            >
              Load {Math.min(PAGE_SIZE, total - loaded)} more
            </button>
          )}
        </>
      )}
    </div>
  );
}
