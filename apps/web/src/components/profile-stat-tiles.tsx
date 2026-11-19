// The profile header's figures: net points, hint spend, and one done/total
// stat per enabled module in that module's own word.
//
// The header used to be three secure-development figures (patched /
// non-patched / total) and nothing else, so a contestant whose points were
// mostly quiz and flags got a header describing a game they were not playing,
// opening with a wall of not-done ("315 non-patched") while their real
// progress sat below the fold (issue #200, 2.4).
//
// Presentational: the page computes every number, including each module's
// clamped denominator.

export type StatTile = {
  /** The module's own unit word — patched / answered / solved / cleared. */
  unit: string;
  done: number;
  total: number;
  /** Optional accent for the numerator; the default is the neutral zinc. */
  accent?: string;
};

export default function ProfileStatTiles({
  netPoints,
  hints,
  tiles,
}: {
  netPoints: number;
  /** The viewer's own spend, itemised — theirs to read, unlike a rival's. */
  hints: { spent: number; count: number };
  tiles: StatTile[];
}) {
  return (
    // Wraps: four modules plus the hint tile overflow the card's width on a
    // narrow screen, and a header that scrolls sideways is worse than one
    // that takes a second line.
    <div className="flex flex-none flex-wrap gap-x-6 gap-y-4 text-right">
      <div>
        <p className="font-mono text-xl font-bold tabular-nums text-white">{netPoints}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted">points</p>
      </div>
      {hints.count > 0 && (
        <div>
          <p className="font-mono text-xl tabular-nums text-[#d4a017]">−{hints.spent}</p>
          <p className="text-[11px] uppercase tracking-wide text-muted">hints ({hints.count})</p>
        </div>
      )}
      {tiles.map((tile) => (
        <div key={tile.unit}>
          <p className="font-mono text-xl tabular-nums" style={{ color: tile.accent ?? "#e4e4e7" }}>
            {tile.done}
            <span className="text-sm text-muted"> / {tile.total}</span>
          </p>
          <p className="text-[11px] uppercase tracking-wide text-muted">{tile.unit}</p>
        </div>
      ))}
    </div>
  );
}
