// The one line on the profile that is not a restatement of something already
// on screen: how much is still winnable, and where most of it is. Everything
// above it answers "how am I doing"; this answers "where should I go next",
// which is the question a contestant actually acts on mid-event.
//
// Presentational and client-safe: the caller passes one entry per enabled
// module, already carrying that module's own earned/max pair on the same
// denominator its row above uses.

export type RemainingModule = {
  title: string;
  earned: number;
  /** Points available. A module whose source reports no point data (max 0)
   *  contributes nothing rather than a negative remainder. */
  max: number;
};

type RemainingSummary = {
  /** Points still on the board across every module. */
  remaining: number;
  /** The module holding most of them, or null when only one module has any
   *  left — naming it there would just repeat the module row above. */
  leader: string | null;
};

export function remainingSummary(modules: RemainingModule[]): RemainingSummary {
  // Per-module clamping, not one clamp at the end: banked points can exceed a
  // shrunken ceiling after an item is deleted or re-priced, and one module's
  // overshoot must not eat another module's genuine remainder.
  const left = modules
    .map((m) => ({ title: m.title, left: Math.max(0, m.max - m.earned) }))
    .filter((m) => m.left > 0);
  const remaining = left.reduce((n, m) => n + m.left, 0);
  if (left.length < 2) return { remaining, leader: null };
  const leader = left.reduce((best, m) => (m.left > best.left ? m : best));
  return { remaining, leader: leader.title };
}

export default function RemainingLine({ modules }: { modules: RemainingModule[] }) {
  const { remaining, leader } = remainingSummary(modules);
  if (remaining <= 0) return null;
  return (
    <p className="px-1 font-mono text-sm tabular-nums text-muted">
      <span className="text-zinc-300">{remaining.toLocaleString("en-US")} pts</span> still on the board
      {leader && <span> · most in {leader}</span>}
    </p>
  );
}
