"use client";

// Interactive leaderboard.
//
// This is a Client Component because everything here needs the browser:
// useState for the query/view/sort/expand state. The server page loads the
// data (and the viewer's session) and hands both down as props — data
// fetching and auth stay on the server, interactivity on the client.

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { completedCount } from "@/lib/leaderboard/rank";
import type { ResolvedModule } from "@/lib/modules";
import type { AppMeta } from "@/lib/apps";
import ScoreTimeChart from "@/components/score-time-chart";
import { EntryRow } from "@/components/leaderboard-rows";
import { TeamRow } from "@/components/leaderboard-team-row";
import type { LeaderboardData } from "@/lib/leaderboard/types";

// Re-exported from their own file (leaderboard-rows.tsx) so the tests and any
// other caller keep importing them from here, where they have always lived.
export { EntryRow, TeamRow };

type View = "individual" | "teams";
type SortKey = "rank" | "points" | "solved";

/** Shown when the board holds no contestants at all (pre-event, or after a
 *  reset) — distinct from a search that simply matched nothing. The framing is
 *  deliberately an invitation rather than an error: the podium is drawn empty
 *  and the copy points at the way onto the board.
 *
 *  WHICH way is the module's to say, not this component's: "patch your first
 *  challenge", pointing at /challenges, is nonsense on a quiz-only event that
 *  has no challenges page at all. The sentence and its destination come from
 *  the first enabled module carrying `emptyBoard` (registry order decides on a
 *  multi-module event, so a secure-development event keeps today's wording and
 *  link verbatim). A module with none contributes nothing and the invitation
 *  degrades to the heading alone rather than to a dead link. */
export function EmptyBoard({ modules }: { modules: readonly ResolvedModule[] }) {
  const copy = modules.find((m) => m.emptyBoard)?.emptyBoard;
  return (
    <div className="flex flex-col items-center gap-5 rounded-lg border border-white/[0.06] bg-[#16162a] px-6 py-10 text-center">
      <Image
        src="/leaderboard-empty.svg"
        alt="An empty winners' podium with an unclaimed flag on the top step"
        width={420}
        height={260}
        className="h-auto w-full max-w-[420px]"
        priority={false}
        unoptimized
      />
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold uppercase tracking-widest text-white">
          The board is wide open
        </h2>
        {copy && <p className="mx-auto max-w-md text-sm text-zinc-400">{copy.line}</p>}
      </div>
      {copy && (
        <Link
          href={copy.cta.href}
          className="rounded-md border border-[#2563eb]/60 bg-white/[0.06] px-4 py-2 font-mono text-sm text-[var(--accent-blue-link)] transition-colors hover:bg-white/[0.1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
        >
          {copy.cta.label}
        </Link>
      )}
    </div>
  );
}

/** Shown when the board has contestants but the query matched none of them.
 *  Always offers the way out (clearing the search) rather than dead-ending. */
function NoMatch({ noun, query, onClear }: { noun: string; query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-white/[0.06] bg-[#16162a] px-5 py-10 text-center">
      <p className="text-base text-zinc-300">
        No {noun} matching <span className="font-mono text-white">&ldquo;{query}&rdquo;</span> on the
        board yet.
      </p>
      <p className="text-sm text-muted">Double-check the spelling, or take another look at everyone.</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-1 rounded-md border border-white/10 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-[#2563eb]/60 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        $ clear search
      </button>
    </div>
  );
}

export default function Leaderboard({
  data,
  viewerLogin,
  modules,
  enabledApps,
}: {
  data: LeaderboardData;
  viewerLogin: string | null;
  modules: readonly ResolvedModule[];
  /** The event's live target list (lib/enabled-apps.ts), resolved server-side
   *  and threaded down to every row's `AppBreakdown`/`ModuleDetail`. */
  enabledApps: readonly AppMeta[];
}) {
  // Teams are the primary competitive unit once they exist — default there
  // and let individual standings be the secondary, opt-in view.
  const showTeamsToggle = data.capabilities.teams && data.teams.length > 0;
  // All three keys are offered on every event now. The third used to be
  // "patched" and was gated on hasSecureDev, because it sorted a column a
  // quiz-only event does not have; it sorts on cross-module completion
  // instead, which every event has, so the gate went with the column.
  const sortKeys: SortKey[] = ["rank", "points", "solved"];

  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>(showTeamsToggle ? "teams" : "individual");
  const [sort, setSort] = useState<SortKey>("rank");
  const [expanded, setExpanded] = useState<string | null>(null);

  const topPoints = useMemo(
    () => data.entries.reduce((max, e) => Math.max(max, e.points), 0),
    [data.entries],
  );
  const topTeamPoints = useMemo(
    () => data.teams.reduce((max, t) => Math.max(max, t.points), 0),
    [data.teams],
  );
  // Each member's individual score, for the expanded team row. A member's own
  // total can exceed their marginal contribution (the team dedupes flags two
  // members both solved), so this is "their points", not "what they added".
  const pointsByLogin = useMemo(
    () => new Map(data.entries.map((e) => [e.login, e.points])),
    [data.entries],
  );

  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.entries
      .filter((e) => (q === "" ? true : e.login.toLowerCase().includes(q) || e.team?.toLowerCase().includes(q)))
      .sort((a, b) => {
        if (sort === "rank") return a.rank - b.rank;
        if (sort === "points") return b.points - a.points;
        // Same figure the column shows and the comparator ranks on.
        return completedCount(b) - completedCount(a);
      });
  }, [data.entries, query, sort]);

  const visibleTeams = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.teams
      .filter((t) => (q === "" ? true : t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)))
      .sort((a, b) => a.rank - b.rank);
  }, [data.teams, query]);

  /** Nothing to search, sort, or count — suppress the chrome so the empty
   *  state stands alone. Teams can exist before anyone has solved anything, so
   *  this checks both collections rather than just `entries`. */
  const boardIsEmpty = data.entries.length === 0 && data.teams.length === 0;

  // The chart plots every enabled module now: the source supplies
  // secure-development's history and `withModuleSeries` merges the app-side
  // modules' per-item timestamps into it (issue #415). It used to plot the
  // source alone while the rows counted everything, so its ceiling could be a
  // tenth of the visible totals — the old caption existed to stop that reading
  // as broken.
  //
  // One gap is left, and it is the one worth naming: hint spend is stored as
  // points, not as timed reveals, so there is no instant to subtract it at.
  // The line is GROSS and the row is net, reconciled by its "−N hints" marker
  // — the same split every module block already uses. Said only when a penalty
  // is actually on this board, so an event that sells no hints (or has sold
  // none yet) carries no caption about them.
  const anyHintPenalty =
    data.entries.some((e) => (e.hintPenalty ?? 0) > 0) || data.teams.some((t) => (t.hintPenalty ?? 0) > 0);
  const chartNote = anyHintPenalty
    ? "Plots every module's points as they were earned. Hint costs are not charted — a row's −N hints marker is what reconciles its line with its total."
    : undefined;

  return (
    <div className="flex flex-col gap-5">
      {/* Chart follows the active view: team lines in "teams", player lines
          in "individual" — only one of the two props is ever passed, so
          ScoreTimeChart never has to choose between them. */}
      <ScoreTimeChart
        series={view === "individual" ? data.series : undefined}
        teamSeries={view === "teams" ? data.teamSeries : undefined}
        note={chartNote}
      />

      {/* Controls */}
      {!boardIsEmpty && (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            type="search"
            id="leaderboard-search"
            name="leaderboard-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={view === "individual" ? "Search contestants…" : "Search teams…"}
            aria-label="Search leaderboard"
            className="w-full rounded-md border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-white placeholder:text-muted focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* The projector surface: chrome-free top ten at wall size. A link,
              not state — organizers open it in its own tab/window. */}
          <Link
            href="/leaderboard?display=1"
            className="rounded-full border border-white/10 px-3 py-1 text-xs font-medium text-zinc-400 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          >
            Display mode
          </Link>
        {showTeamsToggle && (
          <div className="flex flex-wrap items-center gap-2">
            {(["individual", "teams"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] ${
                  view === v
                    ? "border-[#2563eb]/70 bg-white/[0.06] text-[var(--accent-blue-link)]"
                    : "border-white/10 text-zinc-400 hover:text-white"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        </div>
      </div>
      )}

      {view === "individual" && data.entries.length > 0 && (
        <div className="flex items-center gap-4 px-1 text-xs uppercase tracking-wider text-muted">
          <span>Sort:</span>
          {sortKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={`transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] ${
                sort === key ? "text-[#14b8a6]" : "hover:text-zinc-300"
              }`}
            >
              {key}
            </button>
          ))}
        </div>
      )}

      {/* The default order is breadth-first (compareStanding: items solved
          across every module, then points, then earliest activity) — which
          means the top row is NOT necessarily the highest points, and a
          contestant reading "#3" next to the biggest PTS figure on the board
          concludes the ranking is broken unless the rule is stated where the
          ranking is (issue #200, 2.1). Shown only while that order is active:
          the points/solved sorts are self-describing. */}
      {view === "individual" && data.entries.length > 0 && sort === "rank" && (
        <p className="px-1 text-xs leading-relaxed text-muted">
          Rank rewards breadth: challenges solved across every module first, then points as the
          tiebreak, then whoever got there first.
        </p>
      )}

      {view === "individual" ? (
        data.entries.length === 0 ? (
          <EmptyBoard modules={modules} />
        ) : visibleEntries.length === 0 ? (
          <NoMatch noun="contestants" query={query.trim()} onClear={() => setQuery("")} />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {visibleEntries.map((entry) => (
              <EntryRow
                key={entry.login}
                entry={entry}
                topPoints={topPoints}
                isOwn={viewerLogin === entry.login}
                isOpen={expanded === entry.login}
                onToggle={() => setExpanded(expanded === entry.login ? null : entry.login)}
                capabilities={data.capabilities}
                modules={modules}
                completable={data.completable}
                enabledApps={enabledApps}
                catalog={data.catalog}
              />
            ))}
          </ul>
        )
      ) : visibleTeams.length === 0 ? (
        <NoMatch noun="teams" query={query.trim()} onClear={() => setQuery("")} />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {visibleTeams.map((team) => (
            <TeamRow
              key={team.slug}
              team={team}
              topPoints={topTeamPoints}
              pointsByLogin={pointsByLogin}
              modules={modules}
              isOpen={expanded === team.slug}
              onToggle={() => setExpanded(expanded === team.slug ? null : team.slug)}
              enabledApps={enabledApps}
            />
          ))}
        </ul>
      )}

      {!boardIsEmpty && (
        <p className="px-1 text-xs text-muted">
          {view === "individual"
            ? `Showing ${visibleEntries.length} of ${data.entries.length} contestants`
            : `Showing ${visibleTeams.length} of ${data.teams.length} teams`}
          {" · click a row for the breakdown"}
        </p>
      )}
    </div>
  );
}
