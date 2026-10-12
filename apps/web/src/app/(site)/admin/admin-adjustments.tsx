"use client";

// /admin → Support → Score adjustments: a signed points change for a team,
// with a required reason (adjustments-store.ts). The team's total on every
// surface carries it, marked "±N adjustment"; its tie-break time does not
// move. Removing one is audited like adding one.

import { useEffect, useState } from "react";
import { ADJUSTMENT_MAX, isTeamSlug } from "@/lib/adjustment-keys";

export type AdjustmentRow = { id: string; slug: string; points: number; reason: string; by: string; at: string };

/** One ledger row as the list shows it. */
export function adjustmentRow(a: AdjustmentRow): string {
  return `${a.slug} ${a.points > 0 ? "+" : "−"}${Math.abs(a.points)} · ${a.reason} · by ${a.by}`;
}

const INPUT =
  "rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-white focus-visible:border-[#d4a017]/70 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
const BTN =
  "flex-none rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] " +
  "disabled:cursor-not-allowed disabled:border disabled:border-white/10 disabled:bg-transparent disabled:text-zinc-500";

/** The points the form would send, or null when the server would refuse
 *  them: a whole number written as digits, not 0, within ±ADJUSTMENT_MAX. */
export function parseAdjustmentPoints(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n !== 0 && Math.abs(n) <= ADJUSTMENT_MAX ? n : null;
}

/** The ledger as the panel reads it; throws the server's error on a refused
 *  read, so a failure surfaces instead of leaving the list loading. */
export async function fetchAdjustments(): Promise<AdjustmentRow[]> {
  const res = await fetch("/api/admin/adjustments");
  const data = (await res.json().catch(() => ({}))) as { adjustments?: AdjustmentRow[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load adjustments");
  return data.adjustments ?? [];
}

/** What a superseded read resolves to. */
export const STALE = Symbol("stale read");

/** Runs reads so that only the one started last reports: an earlier read
 *  that lands after it (or fails after it) resolves to STALE instead. */
export function latestRead<T>(): (read: () => Promise<T>) => Promise<T | typeof STALE> {
  let latest = 0;
  return async (read) => {
    const mine = ++latest;
    try {
      const value = await read();
      return mine === latest ? value : STALE;
    } catch (err) {
      if (mine !== latest) return STALE;
      throw err;
    }
  };
}

/** What the list area shows: a read that never succeeded is a failure, not
 *  a load still in flight. */
export function listState(rows: readonly AdjustmentRow[] | null, error: string | null): "loading" | "failed" | "list" {
  if (rows !== null) return "list";
  return error ? "failed" : "loading";
}

export default function AdminAdjustments({
  initial = null,
}: {
  /** Seeded rows, for a static render; omitted, the list is fetched. */
  initial?: AdjustmentRow[] | null;
}) {
  const [rows, setRows] = useState<AdjustmentRow[] | null>(initial);
  const [slug, setSlug] = useState("");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read] = useState(() => latestRead<AdjustmentRow[]>());

  async function load() {
    try {
      const list = await read(fetchAdjustments);
      if (list !== STALE) setRows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load adjustments");
    }
  }

  useEffect(() => {
    if (initial !== null) return;
    let cancelled = false;
    read(fetchAdjustments)
      .then((list) => {
        if (!cancelled && list !== STALE) setRows(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load adjustments");
      });
    return () => {
      cancelled = true;
    };
  }, [initial, read]);

  async function send(method: "POST" | "DELETE", body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/adjustments", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      if (method === "POST") {
        setSlug("");
        setPoints("");
        setReason("");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  const parsed = parseAdjustmentPoints(points);
  const ready = isTeamSlug(slug) && reason.trim() !== "" && parsed !== null;

  return (
    <section className="flex flex-col gap-3 border-t border-white/[0.06] pt-5">
      <div>
        <h3 className="text-sm font-semibold text-white">Score adjustments</h3>
        <p className="text-sm text-muted">
          A bonus or penalty for a team, with the reason. It shows on the team&apos;s total everywhere as
          &ldquo;±N adjustment&rdquo;, never touches anyone&apos;s hint balance, and does not change who got there
          first in a tie. The total never goes below 0.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Team slug" placeholder="team slug" value={slug} onChange={(e) => setSlug(e.target.value)} className={`w-40 font-mono ${INPUT}`} />
        <input aria-label="Points (negative for a penalty)" placeholder="±points" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} className={`w-24 text-right ${INPUT}`} />
        <input aria-label="Reason" placeholder="reason (required)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className={`min-w-48 flex-1 ${INPUT}`} />
        <button type="button" disabled={pending || !ready} className={BTN} onClick={() => void send("POST", { slug: slug.trim(), points: parsed, reason })}>
          Add adjustment
        </button>
      </div>
      {rows === null ? (
        listState(rows, error) === "loading" && <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No adjustments yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-white/[0.06] px-3 py-1.5 text-sm text-zinc-300">
              <span className="min-w-0 truncate">{adjustmentRow(a)}</span>
              <button
                type="button"
                disabled={pending}
                aria-label={`Remove adjustment for ${a.slug}`}
                onClick={() => void send("DELETE", { id: a.id })}
                className="flex-none rounded-md border border-white/10 px-2 py-0.5 text-xs text-zinc-300 hover:text-white disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-[#e53e3e]">
          {error}
        </p>
      )}
    </section>
  );
}
