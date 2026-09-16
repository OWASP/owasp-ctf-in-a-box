"use client";

// A team's row on the board, and the read-only progress tree it expands into:
// one ProgressRow per module, secure-development opening into the same
// per-target rows a contestant sees on their own profile.
//
// It replaced two half-answers — a chip row giving each module's points with
// no denominator ("58 pts 38 patched"), and a target breakdown below it giving
// counts with no points.

import type { ModuleId, ResolvedModule } from "@/lib/modules";
import type { AppMeta } from "@/lib/apps";
import AppBreakdown from "@/components/app-breakdown";
import BoardItemLists from "@/components/board-item-lists";
import ProgressRow, { moduleUnit } from "@/components/progress/progress-row";
import { Avatar, RankChip } from "@/components/leaderboard-chrome";
import { fillStyle } from "@/components/progress/progress-bar";
import type { LeaderboardEntry, ModuleProgress, TeamStanding, LeaderboardData } from "@/lib/leaderboard/types";


/** One team module's numbers in the shared row's vocabulary. The team board
 *  carries per-module TOTALS but no per-module maxima, so `max` is the sum of
 *  the target ceilings where the catalogue supplies them (secure-development)
 *  and 0 elsewhere — the row then shows the points earned without inventing a
 *  denominator. */
function teamModuleRow(id: ModuleId, progress: ModuleProgress, team: TeamStanding) {
  const base = { unit: moduleUnit(id), earned: progress.points };
  const detail = progress.detail;
  switch (detail.kind) {
    case "quiz":
      return { ...base, done: detail.answered, total: detail.total, max: 0 };
    case "classic":
    case "ai":
      return { ...base, done: detail.solved, total: detail.total, max: 0 };
    case "secure-development": {
      const apps = Object.values(team.apps ?? detail.apps);
      // `completed` is the authoritative count (the union fold computes it);
      // the targets supply the denominator and the ceiling, and the
      // denominator is clamped to the numerator so a team whose per-target
      // data is missing reads "6 / 6", never "6 / 0".
      const done = progress.completed;
      return {
        ...base,
        done,
        total: Math.max(
          apps.reduce((n, a) => n + (a?.total ?? 0), 0),
          done,
        ),
        max: apps.reduce((n, a) => n + (a?.maxPoints ?? 0), 0),
      };
    }
    default: {
      const unhandled: never = detail;
      return unhandled;
    }
  }
}


/** Exported (in addition to the page's default `Leaderboard`) purely so
 *  tests can render an expanded row directly with `isOpen` — the toggle
 *  itself only flips client-side state that a static render can't drive. */
/** AppBreakdown takes a LeaderboardEntry; a team standing is not one, and the
 *  breakdown only ever reads `apps`. The rest is filled in here rather than
 *  giving the component a second, team-shaped prop. */
const TEAM_ENTRY_STUB: Omit<LeaderboardEntry, "login" | "apps"> = {
  rank: 0,
  team: null,
  points: 0,
  patched: 0,
  failed: 0,
  total: 0,
  updatedAt: null,
};

export function TeamRow({
  team,
  topPoints,
  pointsByLogin,
  isOpen,
  onToggle,
  modules = [],
  enabledApps,
  catalog,
}: {
  team: TeamStanding;
  topPoints: number;
  pointsByLogin?: Map<string, number>;
  isOpen: boolean;
  onToggle: () => void;
  modules?: readonly ResolvedModule[];
  enabledApps: readonly AppMeta[];
  /** `LeaderboardData.catalog` — joined against `team.apps[].solvedIds` when
   *  the row is open (issue #434); see EntryRow. */
  catalog?: LeaderboardData["catalog"];
}) {
  const moduleRows = modules.filter((m) => team.modules?.[m.id]);
  return (
    <li className="ds-card group rounded-lg border border-white/[0.06] bg-[#16162a] transition-all hover:border-[#2563eb]/40 hover:bg-[#1a1a30]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full rounded-lg p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] sm:p-4"
      >
        <div className="flex items-center gap-3 sm:gap-4">
          <RankChip rank={team.rank} />
          <div className="min-w-0 flex-1">
            <span className="truncate font-medium text-white">{team.name}</span>
            {/* Same reason as the contestant row: `members` is a
                `hidden sm:block` on the right, so a phone lost the only
                indication of how large the team behind a score is. */}
            <p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted sm:hidden">
              {team.members.length} member{team.members.length === 1 ? "" : "s"}
            </p>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#14b8a6]"
                style={fillStyle(topPoints > 0 ? (team.points / topPoints) * 100 : 0, team.points)}
              />
            </div>
          </div>
          <div className="flex flex-none items-center gap-3 text-right sm:gap-5">
            <div>
              <p className="font-mono text-xl font-bold tabular-nums text-white">
                {team.points.toLocaleString("en-US")}
              </p>
              {/* "net pts", not "pts" with a −N hints line under it: what a
                  team spent on hints is theirs, and the figure that matters
                  to everyone else is the one it is ranked on. The
                  contestant's own spend is still itemised on their profile,
                  where it is their own business to read. */}
              <p className="text-[11px] uppercase tracking-wide text-muted">net pts</p>
            </div>
            <div className="hidden sm:block">
              <p className="font-mono text-base tabular-nums text-zinc-300">{team.members.length}</p>
              <p className="text-[11px] uppercase tracking-wide text-muted">members</p>
            </div>
            <svg
              className={`text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
      </button>
      {isOpen && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-4">
            {team.members.map((login) => (
              <span
                key={login}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#12121e] py-1 pl-1 pr-2 text-xs text-zinc-300"
              >
                <Avatar login={login} size={18} />
                {login}
                {login === team.captain && (
                  <span className="flex-none rounded border border-[#d4a017]/50 bg-[#d4a017]/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-[#d4a017]">
                    captain
                  </span>
                )}
                <span className="flex-none rounded-full bg-white/[0.06] px-1.5 py-0.5 font-mono tabular-nums text-[11px] text-zinc-200">
                  {(pointsByLogin?.get(login) ?? 0).toLocaleString("en-US")} pts
                </span>
              </span>
            ))}
          </div>
          {/* Where the total CAME from — the same tree a contestant sees on
              their own profile, read-only. It replaces two half-answers: a
              chip row that gave each module's points with no denominator
              ("58 pts 38 patched"), and a separate target breakdown below it
              that gave counts with no points. `team.modules` is the
              union-deduped per-module fold; secure-development opens into
              the same per-target rows AppBreakdown draws on the profile.
              Rendered on a single-module event too: the module's name is
              redundant there, its numbers are not (issue #200, 2.2). */}
          {!moduleRows.length && team.apps && (
            // A source that carries targets but no per-module fold (the
            // overlay off, or a board built straight from a source) still
            // gets its targets — the same rows, one level down, rather than
            // an expansion with nothing in it.
            <div className="mt-4 border-t border-white/[0.06] pt-4">
              <p className="mb-3 text-xs uppercase tracking-wider text-muted">Target breakdown</p>
              <AppBreakdown entry={{ ...TEAM_ENTRY_STUB, login: team.slug, apps: team.apps }} showPoints enabledApps={enabledApps} catalog={catalog} />
            </div>
          )}
          {moduleRows.length > 0 && (
            <div className="mt-4 flex flex-col gap-1 border-t border-white/[0.06] pt-4">
              {moduleRows.map((m) => {
                  const progress = team.modules![m.id]!;
                  return (
                    <ProgressRow key={m.id} label={m.title} level="module" {...teamModuleRow(m.id, progress, team)}>
                      {progress.detail.kind === "secure-development" && team.apps ? (
                        <AppBreakdown entry={{ ...TEAM_ENTRY_STUB, login: team.slug, apps: team.apps }} showPoints enabledApps={enabledApps} catalog={catalog} />
                      ) : undefined}
                    </ProgressRow>
                  );
                })}
            </div>
          )}
          {/* The team's quiz/classic items — the members' UNION, matching how
              the team banks points. Same lazy fetch as the entry rows. */}
          {/* Same derived gate as EntryRow's, and for the same reason: a
              hand-listed `quiz || classic || ai` check silently excluded ai
              once, and would do it again for the next module too. */}
          {Object.keys(team.modules ?? {}).some((id) => id !== "secure-development") && team.members.length > 0 && (
            <BoardItemLists logins={team.members} />
          )}
        </div>
      )}
    </li>
  );
}

