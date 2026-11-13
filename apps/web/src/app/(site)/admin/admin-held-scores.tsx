"use client";

// Read-only list of Secure Development scores held for PR authors with no
// linked account (GET /api/admin/sd/held). `unclaimed` rows can no longer be
// released by a link. Nothing here acts on a row.

import { useEffect, useState } from "react";
import type { HeldScore } from "@/lib/sd-held";

const CELL = "px-2 py-1 text-left align-top";

export function HeldScoresList({ entries }: { entries: HeldScore[] }) {
  if (entries.length === 0) return <p className="text-sm text-zinc-400">No held scores.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-zinc-200">
        <thead className="text-xs uppercase text-zinc-400">
          <tr>
            <th className={CELL}>Login</th>
            <th className={CELL}>Target</th>
            <th className={CELL}>Challenges</th>
            <th className={CELL}>PR</th>
            <th className={CELL}>Comment time</th>
            <th className={CELL}>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.login}-${e.pr}-${e.at}-${i}`} className="border-t border-white/10">
              <td className={CELL}>{e.login}</td>
              <td className={CELL}>{e.target}</td>
              <td className={CELL}>{e.solved.join(", ")}</td>
              <td className={CELL}>#{e.pr}</td>
              <td className={CELL}>{e.at}</td>
              <td className={CELL}>{e.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminHeldScores() {
  const [entries, setEntries] = useState<HeldScore[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/admin/sd/held", { signal: ctl.signal });
        const data = (await res.json().catch(() => ({}))) as { entries?: HeldScore[] };
        if (ctl.signal.aborted) return;
        if (!res.ok || !Array.isArray(data.entries)) setError("Could not load held scores");
        else setEntries(data.entries);
      } catch {
        if (!ctl.signal.aborted) setError("Could not load held scores");
      }
    })();
    return () => ctl.abort();
  }, []);

  return (
    <section className="flex flex-col gap-2" aria-labelledby="held-scores-heading">
      <h3 id="held-scores-heading" className="text-sm font-semibold text-white">
        Held and unclaimed scores
      </h3>
      <p className="text-xs text-zinc-400">
        Held scores are released when their author links a GitHub account before scoring closes. Unclaimed scores can
        no longer be released.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : entries ? (
        <HeldScoresList entries={entries} />
      ) : (
        <p className="text-sm text-zinc-400">Loading…</p>
      )}
    </section>
  );
}
