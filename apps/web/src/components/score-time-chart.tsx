"use client";

// Leaderboard line chart — top contestants' (or top teams') cumulative score
// over time, rendered inside the leaderboard, above the table/rows.
//
// The chart geometry is a pure function of its `series`/`teamSeries` props (a
// deterministic SVG, identical server- or client-side). On top of that it
// carries one piece of client interactivity: a hover crosshair + tooltip that
// reads out every plotted series' cumulative score at the pointed-to time
// (step semantics — a series' "points so far" is its last solve at or before
// that instant). It's nested inside <Leaderboard> (already a client component)
// and switches between the player and team series as the view toggle flips.
//
// Colors: the dataviz skill's validated default categorical palette (dark
// steps), re-validated with the skill's validator against this app's actual
// --background (#1a1a2e) rather than the skill's generic dark surface — all
// eight slots clear the lightness/chroma/CVD/contrast gates in fixed order.
// A 9th+ line is never a generated hue (the skill's #1 anti-pattern): ranks
// 9-10 fold into a single shared muted "Other" entry instead.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerSeries, SeriesPoint, TeamSeries } from "@/lib/leaderboard/types";

const SERIES_COLORS = [
  "#2563eb", // 1 blue
  "#d95926", // 2 orange
  "#199e70", // 3 aqua
  "#c98500", // 4 yellow
  "#d55181", // 5 magenta
  "#008300", // 6 green
  "#9085e9", // 7 violet
  "#e66767", // 8 red
] as const;

/** Shared color for any player past the fixed 8-hue categorical ceiling. */
const OTHER_COLOR = "#8f8f9b"; // --text-muted

const WIDTH = 720;
const HEIGHT = 300;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 48 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const Y_TICK_COUNT = 4;
const X_TICK_COUNT = 5;

/** Rounds a maximum up to a "clean" axis ceiling (1/2/5 x a power of ten),
 *  per the skill's "round to clean numbers" y-axis guidance. */
function niceMax(value: number): number {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatTimeTick(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Series-agnostic input to the shared chart core: a player's login or a
 *  team's name/slug, either way just a labeled, keyed point history. */
type ChartSeries = { key: string; label: string; points: SeriesPoint[] };

type PlottedLine = {
  key: string;
  label: string;
  color: string;
  path: string;
  /** The line's right-edge endpoint — the one emphasized marker per series. */
  end: { x: number; y: number };
  /** Sorted-ascending raw (time-ms, cumulative-score) history — drives the
   *  hover tooltip's "score so far" lookup and the crosshair dot placement. */
  raw: { t: number; score: number }[];
};

/** The shared SVG line chart: series-agnostic core reused by both the player
 *  and team entry points below, so hue assignment, the "Other" fold, and
 *  axis logic stay in one place regardless of what's being plotted.
 *  `noun` is the singular unit name used in the heading/legend copy
 *  ("contestant" or "team"). */
function renderChart(entries: ChartSeries[], noun: string, note?: string) {
  const withPoints = entries.filter((s) => s.points.length > 0);
  if (withPoints.length === 0) return null;

  const allTimes = withPoints.flatMap((s) => s.points.map((p) => Date.parse(p.t))).filter(Number.isFinite);
  if (allTimes.length === 0) return null;

  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);

  // Every point across every player shares one instant — there's no time
  // range to draw an x-axis over. Note instead of a broken/zero-width chart.
  if (minT === maxT) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-[#16162a] px-4 py-6 text-center text-sm text-muted">
        Not enough score history yet to chart.
      </div>
    );
  }

  const allScores = withPoints.flatMap((s) => s.points.map((p) => p.score));
  const maxScore = niceMax(Math.max(0, ...allScores));

  const x = (ms: number) => MARGIN.left + ((ms - minT) / (maxT - minT)) * PLOT_W;
  const y = (score: number) => MARGIN.top + PLOT_H - (score / maxScore) * PLOT_H;

  // Highest final score first: that ordering also decides which players get
  // one of the 8 fixed categorical hues (color follows identity once
  // assigned — see the "recolor on filter" anti-pattern — but this fixture
  // is a fresh render each time, so ranking here is just the assignment
  // rule, not a live repaint).
  const ranked = [...withPoints].sort((a, b) => {
    const aFinal = a.points[a.points.length - 1]?.score ?? 0;
    const bFinal = b.points[b.points.length - 1]?.score ?? 0;
    return bFinal - aFinal;
  });

  const lines: PlottedLine[] = ranked.map((s, i) => {
    const color = i < SERIES_COLORS.length ? SERIES_COLORS[i] : OTHER_COLOR;
    const raw = [...s.points]
      .filter((p) => Number.isFinite(Date.parse(p.t)))
      .map((p) => ({ t: Date.parse(p.t), score: p.score }))
      .sort((a, b) => a.t - b.t);
    // Cumulative score IS a step function (scoreAt, which the tooltip reads,
    // says exactly this) — so the drawn line is a step too. The old straight
    // diagonals drew scores nobody ever had, and disagreed with the tooltip
    // riding the steps. Anchored at zero on the left edge and held flat to
    // the right edge: every series starts where every team started and ends
    // at the score it still has, instead of floating in from its first solve
    // and truncating at its last.
    const seg = [`M ${x(minT).toFixed(2)} ${y(0).toFixed(2)}`];
    let prev = 0;
    for (const p of raw) {
      seg.push(`L ${x(p.t).toFixed(2)} ${y(prev).toFixed(2)}`);
      seg.push(`L ${x(p.t).toFixed(2)} ${y(p.score).toFixed(2)}`);
      prev = p.score;
    }
    seg.push(`L ${x(maxT).toFixed(2)} ${y(prev).toFixed(2)}`);
    return { key: s.key, label: s.label, color, path: seg.join(" "), end: { x: x(maxT), y: y(prev) }, raw };
  });

  const foldedCount = Math.max(0, lines.length - SERIES_COLORS.length);
  const yTicks = Array.from({ length: Y_TICK_COUNT + 1 }, (_, i) => (maxScore / Y_TICK_COUNT) * i);
  const xTicks = Array.from({ length: X_TICK_COUNT + 1 }, (_, i) => minT + ((maxT - minT) / X_TICK_COUNT) * i);

  return (
    <InteractiveChart
      lines={lines}
      foldedCount={foldedCount}
      yTicks={yTicks}
      xTicks={xTicks}
      minT={minT}
      maxT={maxT}
      maxScore={maxScore}
      noun={noun}
      note={note}
    />
  );
}

/** A series' cumulative score AT time `t`: its last recorded solve at or
 *  before `t` (step semantics — score only rises on a solve), 0 before any.
 *  Exported for unit testing the hover readout. */
export function scoreAt(raw: { t: number; score: number }[], t: number): number {
  let s = 0;
  for (const p of raw) {
    if (p.t <= t) s = p.score;
    else break;
  }
  return s;
}

/** The rendered chart with a hover crosshair + tooltip. Split out from
 *  renderChart so the hooks here always run (renderChart's degenerate branches
 *  return before reaching this), keeping the rules of hooks satisfied. */
function InteractiveChart({
  lines,
  foldedCount,
  yTicks,
  xTicks,
  minT,
  maxT,
  maxScore,
  noun,
  note,
}: {
  lines: PlottedLine[];
  foldedCount: number;
  yTicks: number[];
  xTicks: number[];
  minT: number;
  maxT: number;
  maxScore: number;
  noun: string;
  note?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  // The scroll container defaults to scrolled-left, i.e. the OLDEST end of
  // the domain — and a series' oldest events are often long-dead history
  // (this box's own first-ever solve, say) with everything that actually
  // matters compressed into the last sliver of the width. On a viewport
  // narrower than the SVG's `min-w` (mobile), that left the chart looking
  // like a flat line at zero unless someone thought to scroll it — the
  // "score over time" line was ending up "score over ancient history plus a
  // pixel of today". Land on the right (most-recent) edge instead, same as
  // any chat/log view opens at the newest entry. Re-runs when the plotted
  // domain changes (a view toggle swaps `lines` for an entirely different
  // series) so a stale scroll position from the last dataset doesn't linger.
  //
  // `lines` is a fresh array every render (renderChart rebuilds it from
  // scratch each call), so keying the effect on it directly reran this on
  // every unrelated rerender — e.g. a live leaderboard poll — snapping a
  // contestant who had scrolled left back to the right edge. Depend on a
  // cheap content signature instead: stable across renders that don't
  // actually change what's plotted, still distinct across a real view
  // toggle even on the rare case minT/maxT happen to coincide.
  const linesSignature = useMemo(
    () => lines.map((l) => `${l.key}:${l.raw.map((p) => `${p.t}:${p.score}`).join(",")}`).join("|"),
    [lines],
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [minT, maxT, linesSignature]);

  const x = (ms: number) => MARGIN.left + ((ms - minT) / (maxT - minT)) * PLOT_W;
  const y = (score: number) => MARGIN.top + PLOT_H - (score / maxScore) * PLOT_H;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const local = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    setHoverX(Math.max(MARGIN.left, Math.min(WIDTH - MARGIN.right, local.x)));
  }

  const hoverT = hoverX == null ? null : minT + ((hoverX - MARGIN.left) / PLOT_W) * (maxT - minT);
  const rows =
    hoverT == null
      ? []
      : lines
          .map((l) => ({ key: l.key, label: l.label, color: l.color, score: scoreAt(l.raw, hoverT) }))
          .sort((a, b) => b.score - a.score);
  // Position the tooltip on whichever side of the crosshair has room.
  const hoverPct = hoverX == null ? 0 : (hoverX / WIDTH) * 100;
  const tooltipLeftSide = hoverPct > 58;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-[#16162a] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white">Score over time</h2>
        <span className="text-xs text-muted">
          Top {lines.length} {noun}
          {lines.length === 1 ? "" : "s"}
        </span>
      </div>
      {/* What this chart does and does not plot. On a multi-module event the
          series carries only the scorer's history, so its ceiling sits far
          below the row totals — unlabeled, that reads as a broken chart
          rather than a narrower one. */}
      {note && <p className="text-xs leading-relaxed text-muted">{note}</p>}

      <div ref={scrollRef} className="relative w-full overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Cumulative score over time for the top ${lines.length} ${noun}${lines.length === 1 ? "" : "s"}`}
          className="h-auto w-full min-w-[480px] touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHoverX(null)}
        >
          <title>Score over time</title>

          {/* Gridlines: recessive hairlines, one step off the card surface. */}
          {yTicks.map((t) => (
            <line
              key={`grid-${t}`}
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(t)}
              y2={y(t)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          ))}

          {/* Axes */}
          <line
            x1={MARGIN.left}
            x2={MARGIN.left}
            y1={MARGIN.top}
            y2={HEIGHT - MARGIN.bottom}
            stroke="rgba(255,255,255,0.14)"
            strokeWidth={1}
          />
          <line
            x1={MARGIN.left}
            x2={WIDTH - MARGIN.right}
            y1={HEIGHT - MARGIN.bottom}
            y2={HEIGHT - MARGIN.bottom}
            stroke="rgba(255,255,255,0.14)"
            strokeWidth={1}
          />

          {/* Y-axis labels: rounded ceiling, so ticks land on clean numbers. */}
          {yTicks.map((t) => (
            <text
              key={`ytick-${t}`}
              x={MARGIN.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-current text-muted"
              fontSize={10}
            >
              {Math.round(t).toLocaleString("en-US")}
            </text>
          ))}

          {/* X-axis labels. The first and last tick sit on the plot's edges,
              so a centered label would hang half outside the viewBox and
              clip ("Aug 22, 11:0…") — anchor the ends inward instead. */}
          {xTicks.map((t, i) => (
            <text
              key={`xtick-${t}`}
              x={x(t)}
              y={HEIGHT - MARGIN.bottom + 16}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              className="fill-current text-muted"
              fontSize={10}
            >
              {formatTimeTick(t)}
            </text>
          ))}

          {/* Step lines + ONE emphasized endpoint marker per series. A dot at
              every solve turned a busy hour into an unreadable caterpillar of
              overlapping circles — the hover crosshair is the per-solve
              readout; the resting render keeps only the line and where it
              ended up. */}
          {lines.map((line) => (
            <g key={line.key}>
              <path d={line.path} fill="none" stroke={line.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <circle cx={line.end.x} cy={line.end.y} r={4} fill={line.color} stroke="#16162a" strokeWidth={2} />
            </g>
          ))}

          {/* Hover crosshair + per-line markers at the pointed-to time. */}
          {hoverX != null && (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={MARGIN.top}
                y2={HEIGHT - MARGIN.bottom}
                stroke="rgba(255,255,255,0.28)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {/* Dots ride the STEP the line draws — same scoreAt the tooltip
                  reads, so the marker and the number can never disagree. */}
              {lines.map((line) => {
                if (hoverT == null) return null;
                const yy = y(scoreAt(line.raw, hoverT));
                return <circle key={`h-${line.key}`} cx={hoverX} cy={yy} r={4.5} fill={line.color} stroke="#1a1a2e" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>

        {/* Tooltip: HTML overlay so the readout stays crisp and easy to style;
            positioned by the crosshair's horizontal fraction of the SVG. */}
        {hoverX != null && hoverT != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-max max-w-[240px] rounded-md border border-white/10 bg-[#1a1a2e]/95 px-2.5 py-2 text-xs shadow-lg"
            style={{
              left: `${hoverPct}%`,
              transform: tooltipLeftSide ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            }}
          >
            <p className="mb-1 font-mono text-[10px] text-muted">{formatTimeTick(hoverT)}</p>
            <ul className="flex flex-col gap-0.5">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: r.color }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{r.label}</span>
                  <span className="flex-none font-mono tabular-nums text-white">{r.score.toLocaleString("en-US")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Legend: the dependable identity channel — a single series needs no
          legend box (the heading above already names it), but the leaderboard
          chart is almost always multi-player. */}
      {lines.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
          {lines.slice(0, SERIES_COLORS.length).map((line) => (
            <li key={line.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: line.color }} />
              <span className="font-mono text-zinc-300">{line.label}</span>
            </li>
          ))}
          {foldedCount > 0 && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: OTHER_COLOR }} />
              <span className="text-muted">+{foldedCount} more</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Server-rendered leaderboard chart: plots either the top-10 players'
 *  cumulative score (`series`) or per-team totals (`teamSeries`) — never
 *  both at once. The leaderboard passes whichever matches its active view
 *  ("individual" vs "teams"), leaving the other prop undefined. `teamSeries`
 *  wins if both happen to be supplied. */
export default function ScoreTimeChart({
  series,
  teamSeries,
  note,
}: {
  series?: PlayerSeries[];
  teamSeries?: TeamSeries[];
  /** One sentence on what the series does and does not include — rendered
   *  under the heading. The leaderboard passes it on multi-module events,
   *  where the plotted history is narrower than the totals beside it. */
  note?: string;
}) {
  if (teamSeries) {
    return renderChart(
      teamSeries.map((t) => ({ key: t.slug, label: t.name, points: t.points })),
      "team",
      note,
    );
  }
  // No rubric (declarative-only deployment) or an older scorer that doesn't
  // send series at all — hide entirely rather than show a broken/empty chart.
  if (!series || series.length === 0) return null;
  return renderChart(
    series.map((s) => ({ key: s.login, label: s.login, points: s.points })),
    "contestant",
    note,
  );
}
