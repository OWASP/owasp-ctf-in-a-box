// The one bar every progress surface draws. It tracks POINTS (earned of max),
// never the item count: points are what the leaderboard ranks on and the only
// measure that means the same thing at every level of the tree (event, module,
// target), so a module's bar and its targets' bars can be read against each
// other. The count travels as text beside it.
//
// The design doc's third, hatched "attempted" segment is deliberately absent:
// its own open question proposed gating it behind an event.yaml flag, and the
// organizer chose to drop the segment rather than ship it ungated.
//
// Presentational and client-safe: no state, no data reads. Callers own the
// numbers and their clamping rules.

/** Minimum visible fill once anything is earned. At 2/668 an honest
 *  percentage is a third of a pixel — indistinguishable from zero for the
 *  first half of an event, which is exactly when a contestant most needs to
 *  see that they are on the board. */
export const MIN_FILL_PX = 4;

type BarReading = {
  /** What the bar fills to. */
  value: number;
  /** What it fills against. */
  ceiling: number;
  /** True when this reading fell back to the item count because the source
   *  carries no point data (lambda without a catalogue reports maxPoints 0). */
  fellBack: boolean;
};

/** Points where there are points, item count where there are none. A zero
 *  ceiling would otherwise render every bar empty AND advertise a "/ 0"
 *  denominator — the shape of the profile's "8 / 0 pts" bug. */
export function barReading(earned: number, max: number, done: number, total: number): BarReading {
  if (max > 0) return { value: earned, ceiling: max, fellBack: false };
  return { value: done, ceiling: total, fellBack: true };
}

/** Clamped both ends: a re-priced or deleted item can leave banked points
 *  above a shrunken ceiling, and a bar cannot be more than full. */
export function fillPercent(value: number, ceiling: number): number {
  if (ceiling <= 0 || value <= 0) return 0;
  return Math.min(100, (value / ceiling) * 100);
}

/** The one place the width/min-width pair is assembled, so every hand-rolled
 *  fill (profile header, progress-summary, challenge-grid, the leaderboard
 *  rows) draws the same rule this component does rather than reinventing it
 *  without the floor. `pct` is whatever percentage the caller already
 *  computed (points-based here, sometimes item-count-based elsewhere); `value`
 *  is the raw numerator that percentage came from — a nonzero score under
 *  ~0.2% of a wide bar rounds to a fraction of a device pixel and paints
 *  nothing without this floor. */
export function fillStyle(pct: number, value: number): { width: string; minWidth: number } {
  return { width: `${pct}%`, minWidth: value > 0 ? MIN_FILL_PX : 0 };
}

export default function ProgressBar({
  label,
  done,
  total,
  unit,
  earned,
  max,
  className = "",
}: {
  /** What the bar belongs to — "Juice Shop", "Quiz". Read out first. */
  label: string;
  done: number;
  total: number;
  /** The module's own word for a completed item: patched / answered / … . */
  unit: string;
  earned: number;
  max: number;
  className?: string;
}) {
  const { value, ceiling } = barReading(earned, max, done, total);
  const pct = fillPercent(value, ceiling);
  // The ARIA pair is clamped the same way the fill is. Banked points survive a
  // deleted or re-priced item, so `value` can legitimately exceed `ceiling` —
  // and a bar that renders full while announcing "300 of 200" is a bar that
  // lies to exactly the readers who cannot see it.
  const ariaCeiling = Math.max(0, ceiling);
  const ariaValue = Math.min(ariaCeiling, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={ariaCeiling}
      aria-valuenow={ariaValue}
      // The bar's own numbers are points; the count is the thing a contestant
      // actually says out loud, so it rides in the label rather than being
      // dropped for screen-reader users.
      aria-label={`${label}: ${done} of ${total} ${unit}`}
      className={`h-1.5 overflow-hidden rounded-full bg-white/[0.06] ${className}`}
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#14b8a6]"
        style={fillStyle(pct, value)}
      />
    </div>
  );
}
