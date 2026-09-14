"use client";

// Event engagement metrics (issue #169).
//
// Loaded when this becomes the active destination, not on mount: this is an
// O(contestants) fold over Redis, and an organizer opening the sidebar to
// reach Support should not pay for it. While the event phase is live it then
// recomputes every 30 s (use-live-poll.ts — half Overview's cadence, because
// of that fold), with the stamp saying how old the read is; the Refresh
// button is the same code path for an organizer who won't wait.
//
// Everything here comes from data the box already stores. There is no
// collection step and nothing is fetched from a contestant's fork; see
// metrics-store.ts for why fork-reported engagement would be forgeable by the
// contestants it measures.

import { useCallback, useState } from "react";
import AdminLiveStamp from "./admin-live-stamp";
import { moduleLabel } from "./vocabulary";
import { SLOW_POLL_MS, useLivePoll } from "./use-live-poll";

type ChallengeStat = {
  module: "quiz" | "classic" | "ai";
  id: string;
  /** The organizer's own name for it. Null when the catalogue no longer holds
   *  it — a challenge deleted after it was solved keeps its metrics — so every
   *  render falls back to the id (metrics-store.ts, audit F7). */
  title: string | null;
  solves: number;
  attempts: number;
  solveRate: number | null;
  avgAttemptsToSolve: number | null;
  medianSecondsToSolve: number | null;
  solvedAfterHint: number;
};

type EventMetrics = {
  generatedAt: string;
  funnel: { onATeam: number; everOnATeam: number; attempted: number; scored: number; stuck: number };
  challenges: ChallengeStat[];
  timeline: { at: string; solves: number }[];
  teams: { slug: string; name: string; size: number; points: number }[];
  modules: { quiz: number; classic: number; ai: number; secureDevelopment: number };
  hints: { buyers: number; totalSpend: number; boughtBeforeSolving: number; boughtAfterSolving: number };
  caveats: string[];
};

function Figure({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3">
      <p className="font-mono text-xl tabular-nums text-white">{value}</p>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      {hint && <p className="mt-1 text-sm leading-tight text-muted">{hint}</p>}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** Compact duration. An em dash for null, which here means "not knowable" —
 *  items earned before the first-attempt timestamp existed carry no start. */
function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** The sparkline's time axis: first, middle and last bucket, as "HH:MM" UTC —
 *  prefixed with "MM-DD" when the buckets span more than one calendar day,
 *  because "22:50 … 01:10" on its own reads backwards. Sliced from the stored
 *  ISO strings, never a clock read, so the server render and hydration agree.
 *  `null` for fewer than two buckets: one tick is not an axis. Exported for
 *  direct testing — the section only renders after a fetch. */
export function axisLabels(timeline: readonly { at: string }[]): { start: string; mid: string; end: string } | null {
  if (timeline.length < 2) return null;
  const first = timeline[0].at;
  const last = timeline[timeline.length - 1].at;
  const spansDays = first.slice(0, 10) !== last.slice(0, 10);
  const label = (iso: string) => (spansDays ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16));
  return {
    start: label(first),
    mid: label(timeline[Math.floor((timeline.length - 1) / 2)].at),
    end: label(last),
  };
}

export default function AdminInsightsTab({
  visible = false,
  live = false,
}: {
  /** This is the active destination — gates the first load and the loop.
   *  Optional so a static render (the tests) fetches nothing. */
  visible?: boolean;
  /** The event phase is live (components/phase.ts) — gates the loop. */
  live?: boolean;
}) {
  const [metrics, setMetrics] = useState<EventMetrics | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolves to whether the metrics on screen were replaced: a failed read
  // keeps the previous figures AND leaves the stamp's age alone, so the
  // screen never calls stale numbers freshly updated.
  // An aborted request (the loop withdrew it — see use-live-poll.ts) touches
  // nothing but `pending`.
  const load = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/metrics", { signal });
      const data = (await res.json().catch(() => ({}))) as EventMetrics & { error?: string };
      if (signal.aborted) return false;
      if (!res.ok) {
        setError(data.error ?? "Could not compute metrics");
        return false;
      }
      setMetrics(data);
      return true;
    } catch {
      if (!signal.aborted) setError("Could not compute metrics");
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  const { updatedAt, refresh } = useLivePoll({ visible, live, intervalMs: SLOW_POLL_MS, load });

  // The timeline's tallest bucket sets the bar scale. A sparkline of absolute
  // counts with no reference is unreadable; relative height is the whole
  // signal here ("did the room go quiet, and when").
  const peak = metrics?.timeline.reduce((max, b) => Math.max(max, b.solves), 0) ?? 0;
  const axis = metrics ? axisLabels(metrics.timeline) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {/* Primary (filled) only while nothing is on screen yet — once the
            metrics are showing and recomputing themselves, the button is the
            secondary "now, please". */}
        <button
          type="button"
          disabled={pending}
          onClick={() => void refresh()}
          className={
            metrics
              ? "flex-none rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white disabled:opacity-50"
              : "flex-none rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-50"
          }
        >
          {pending ? "Computing…" : metrics ? "Refresh" : "Compute metrics"}
        </button>
        {metrics && (
          <>
            <a
              href="/api/admin/metrics?format=csv"
              className="flex-none rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white"
            >
              Download challenges CSV
            </a>
            <span className="text-sm text-muted">
              as of {metrics.generatedAt.slice(0, 16).replace("T", " ")} UTC
            </span>
          </>
        )}
        <AdminLiveStamp updatedAt={updatedAt} live={live} intervalMs={SLOW_POLL_MS} />
      </div>

      {!metrics && !error && (
        <p className="text-sm text-muted">
          Reads the event&rsquo;s own stored data — nothing is collected from contestants&rsquo; forks. On a
          large event this takes a moment.
        </p>
      )}

      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}

      {metrics && (
        <>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-white">Participation</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Figure label="On a team" value={metrics.funnel.onATeam} />
              <Figure
                label="Ever on a team"
                value={metrics.funnel.everOnATeam}
                hint="includes contestants who since left"
              />
              <Figure label="Submitted" value={metrics.funnel.attempted} />
              <Figure label="Scored" value={metrics.funnel.scored} />
              <Figure
                label="Stuck"
                value={metrics.funnel.stuck}
                hint="submitted, never scored"
              />
            </div>
          </section>

          {metrics.timeline.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-white">Solves over time</h3>
              <div
                className="flex h-16 items-end gap-px overflow-x-auto"
                role="img"
                aria-label={axis ? `Solves per ten minutes, ${axis.start} to ${axis.end} UTC` : "Solves per ten minutes"}
              >
                {metrics.timeline.map((b) => (
                  <div
                    key={b.at}
                    title={`${b.at.slice(11, 16)} — ${b.solves} solve${b.solves === 1 ? "" : "s"}`}
                    style={{ height: `${peak ? Math.max(4, (b.solves / peak) * 100) : 4}%` }}
                    className="w-2 flex-none rounded-sm bg-[#2563eb]/70"
                  />
                ))}
              </div>
              {/* The axis. Without it the bars say "when did the room go
                  quiet" only relative to each other; with it, at what time. */}
              {axis && (
                <div aria-hidden="true" className="flex justify-between border-t border-white/[0.06] pt-1 font-mono text-xs tabular-nums text-muted">
                  <span>{axis.start}</span>
                  <span>{axis.mid}</span>
                  <span>{axis.end} UTC</span>
                </div>
              )}
              <p className="text-sm text-muted">
                Ten-minute buckets, quiz, classic and AI. Attempt rows carry a first and a last time but not
                one per try, so this is solves, not submissions.
              </p>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-white">
              Hardest first{" "}
              <span className="font-normal text-muted">— fewest solves at the top</span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="text-muted">
                  <tr className="border-b border-white/[0.06] text-left">
                    <th className="py-1 pr-2 font-medium">Challenge</th>
                    <th className="py-1 pr-2 font-medium">Module</th>
                    <th className="py-1 pr-2 text-right font-medium">Solves</th>
                    <th className="py-1 pr-2 text-right font-medium">Attempts</th>
                    <th className="py-1 pr-2 text-right font-medium">Rate</th>
                    <th className="py-1 pr-2 text-right font-medium">Avg tries</th>
                    <th className="py-1 text-right font-medium">Median time</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums text-zinc-300">
                  {metrics.challenges.slice(0, 40).map((c) => (
                    <tr key={`${c.module}:${c.id}`} className="border-b border-white/[0.03]">
                      {/* Title over id, both present. The title is what an
                          organizer reads out; the id is what a support
                          question or a store key names, and is all there is
                          for a challenge deleted since it was solved. */}
                      <td className="py-1 pr-2 font-sans text-white">
                        {c.title ?? c.id}
                        {c.title && <span className="block font-mono text-xs text-muted">{c.id}</span>}
                      </td>
                      <td className="py-1 pr-2 font-sans text-muted">{moduleLabel(c.module)}</td>
                      <td className="py-1 pr-2 text-right">{c.solves}</td>
                      <td className="py-1 pr-2 text-right">{c.attempts}</td>
                      <td className="py-1 pr-2 text-right">{pct(c.solveRate)}</td>
                      <td className="py-1 pr-2 text-right">
                        {c.avgAttemptsToSolve === null ? "—" : c.avgAttemptsToSolve.toFixed(1)}
                      </td>
                      <td className="py-1 text-right">{duration(c.medianSecondsToSolve)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {metrics.challenges.length > 40 && (
              <p className="text-sm text-muted">
                Showing 40 of {metrics.challenges.length}. The CSV has every row.
              </p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-white">Where attention went</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Figure label="Quiz scorers" value={metrics.modules.quiz} />
              <Figure label="Jeopardy scorers" value={metrics.modules.classic} />
              <Figure label="AI scorers" value={metrics.modules.ai} />
              <Figure label="Secure Development scorers" value={metrics.modules.secureDevelopment} />
              <Figure label="Hint buyers" value={metrics.hints.buyers} />
              <Figure label="Points spent on hints" value={metrics.hints.totalSpend} />
              <Figure
                label="Hints that could help"
                value={metrics.hints.boughtBeforeSolving}
                hint={`bought before solving; ${metrics.hints.boughtAfterSolving} came after and bought nothing`}
              />
            </div>
          </section>

          <section className="flex flex-col gap-1 border-t border-white/[0.06] pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              What these numbers do not measure
            </h3>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-muted">
              {metrics.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
