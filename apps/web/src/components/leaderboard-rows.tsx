"use client";

// A contestant's row on the board. Split out of leaderboard.tsx so that file
// stays a board (search, sort, view toggle, empty states) rather than a board
// plus every level of the progress tree beneath it; re-exported from there,
// which is the import path every caller and test uses.

import { completedCount } from "@/lib/leaderboard/rank";
import type { ResolvedModule } from "@/lib/modules";
import type { AppMeta } from "@/lib/apps";
import ModuleDetail from "@/components/module-detail";
import AppBreakdown from "@/components/app-breakdown";
import BoardItemLists from "@/components/board-item-lists";
import { Avatar, RankChip } from "@/components/leaderboard-chrome";
import { fillStyle } from "@/components/progress/progress-bar";
import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard/types";

function LegacyBreakdown({ entry }: { entry: LeaderboardEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-400">
      <span>
        {entry.patched} patched / {entry.total} attempted
      </span>
      {entry.lastPr != null && <span>PR #{entry.lastPr}</span>}
      {entry.lastSha && <span className="font-mono text-xs text-muted">{entry.lastSha.slice(0, 7)}</span>}
    </div>
  );
}

/** Exported (alongside the default `Leaderboard`) so tests can render an
 *  expanded row directly with `isOpen` — the toggle only flips client state a
 *  static render can't drive. */
export function EntryRow({
  entry,
  topPoints,
  isOwn,
  isOpen,
  onToggle,
  capabilities,
  modules,
  completable,
  enabledApps,
  catalog,
}: {
  entry: LeaderboardEntry;
  topPoints: number;
  isOwn: boolean;
  isOpen: boolean;
  onToggle: () => void;
  capabilities: LeaderboardData["capabilities"];
  modules: readonly ResolvedModule[];
  /** The event's live target list — forwarded to `ModuleDetail`/`AppBreakdown`.
   *  See app-breakdown.tsx's doc comment. */
  enabledApps: readonly AppMeta[];
  /** The EVENT's total completable items, for the solved column's
   *  denominator. Undefined when nothing stamped it — the column then shows a
   *  bare count rather than inventing a total. */
  completable?: number;
  /** `LeaderboardData.catalog`, joined against this row's `solvedIds` only
   *  when the row is open (issue #434). */
  catalog?: LeaderboardData["catalog"];
}) {
  // A single-module event has nothing to disambiguate: the row's own points
  // ARE that module's, so a per-module heading would just restate the header
  // above it. Show it only once a second module can contribute.
  //
  // The count comes off the `modules` prop rather than importing the
  // registry here, so this stays a Client Component with no server-only
  // import — the caller already resolved `modules` from the LIVE enabled
  // set (`resolveModules` over `getEnabledModuleIds()`/`getResolvedModules()`,
  // issue #386), so this just reads however many of those it was handed.
  // Both which modules are on and a module's name are runtime now; neither
  // needs a rebuild.
  const multiModule = modules.length > 1;
  // The same function the comparator ranks on — see `completedCount`.
  const solved = completedCount(entry);
  // Clamped to the row's own numerator: a failed module-count read leaves
  // `completable` short (see withModuleContributions), and "28 / 21" is worse
  // than no denominator at all. Hidden entirely when there is nothing
  // trustworthy to divide by.
  const solvedTotal = completable && completable > 0 ? Math.max(completable, solved) : null;
  return (
    <li
      className={`ds-card group rounded-lg border bg-[#16162a] transition-all hover:border-[#2563eb]/40 hover:bg-[#1a1a30] ${
        isOwn ? "border-[#2563eb]/60" : "border-white/[0.06]"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full rounded-lg p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] sm:p-4"
      >
        <div className="flex items-center gap-3 sm:gap-4">
          <RankChip rank={entry.rank} />
          <Avatar login={entry.login} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono font-medium text-white">{entry.login}</span>
              {entry.team && (
                <span className="flex-none rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                  {entry.team}
                </span>
              )}
              {isOwn && (
                <span className="flex-none rounded border border-[#2563eb]/45 bg-white/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent-blue-link)]">
                  you
                </span>
              )}
            </div>
            {/* The ranking figure, restated for the narrow layout. The
                right-hand `solved` column is a `hidden sm:block`, so below
                640px the board dropped the one number that explains its own
                ordering — the exact gap the comment on that column describes
                closing on desktop, left open on the screen most contestants
                read the board on. Restated here rather than unhiding the
                column because at 320px the row already carries a rank chip,
                an avatar, a login, a team tag and the points. */}
            <p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted sm:hidden">
              {solved}
              {solvedTotal !== null && <span className="text-muted"> / {solvedTotal}</span>}{" "}
              solved
            </p>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#14b8a6]"
                style={fillStyle(topPoints > 0 ? (entry.points / topPoints) * 100 : 0, entry.points)}
              />
            </div>
          </div>

          <div className="flex flex-none items-center gap-3 text-right sm:gap-5">
            <div>
              <p className="font-mono text-xl font-bold tabular-nums text-white">
                {entry.points.toLocaleString("en-US")}
              </p>
              <p className="text-[11px] uppercase tracking-wide text-muted">pts</p>
              {entry.hintPenalty ? (
                <p className="font-mono text-[10px] tabular-nums text-[#d4a017]/80" title="Points spent on hints (already deducted)">
                  −{entry.hintPenalty} hints
                </p>
              ) : null}
            </div>
            {/* ONE column, and deliberately the one the board RANKS by.
                It replaced a `patched` + `non-patched` pair that was both
                cluttered and unexplanatory: the two always summed to the
                catalogue, so `non-patched` carried no information `patched`
                didn't already, and NEITHER was the figure the ordering came
                from — leaving rows like "1,061 pts at rank 3, above 550 pts
                at rank 1" with nothing on screen to explain them.
                `completedCount` is imported from the comparator itself so the
                number shown and the number sorted on cannot drift apart.
                Ungated by module, unlike the pair before it: breadth is what
                every event ranks on, including one with no patching in it. */}
            <div className="hidden sm:block">
              <p className="font-mono text-base tabular-nums text-[#22c55e]">
                {solved}
                {solvedTotal !== null && (
                  <span className="text-muted"> / {solvedTotal}</span>
                )}
              </p>
              <p className="text-[11px] uppercase tracking-wide text-muted">solved</p>
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
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-4">
          <div className="mb-3 flex items-center justify-between text-xs text-muted">
            <span className="uppercase tracking-wider">
              {capabilities.apps ? "App breakdown" : "Summary"}
            </span>
            {entry.updatedAgo && <span>Last update {entry.updatedAgo}</span>}
          </div>
          {entry.modules && Object.keys(entry.modules).length > 0 ? (
            modules
              .filter((m) => entry.modules?.[m.id])
              .map((m) => (
                <div key={m.id} className="mb-4 last:mb-0">
                  {multiModule && (
                    <p className="mb-2 text-xs uppercase tracking-wider text-muted">
                      {m.title}
                      <span className="ml-2 font-mono text-zinc-300">{entry.modules![m.id]!.points} pts</span>
                    </p>
                  )}
                  <ModuleDetail
                    moduleId={m.id}
                    progress={entry.modules![m.id]!}
                    entry={entry}
                    enabledApps={enabledApps}
                    catalog={catalog}
                  />
                </div>
              ))
          ) : capabilities.apps ? (
            <AppBreakdown entry={entry} enabledApps={enabledApps} catalog={catalog} />
          ) : (
            <LegacyBreakdown entry={entry} />
          )}
          {/* Which questions / which flags — the same Show-N lists the
              profile blocks carry, lazily fetched now that the row is
              actually open. Only when the entry has app-side activity to
              enumerate. */}
          {/* Derived rather than hand-listed: a hardcoded `quiz || classic ||
              ai` gate silently dropped a module's item list the moment a
              fifth module (ai) shipped without the check being updated to
              name it too. secure-development has its own AppBreakdown above,
              never BoardItemLists, so it's the one id excluded here. */}
          {Object.keys(entry.modules ?? {}).some((id) => id !== "secure-development") && (
            <BoardItemLists logins={[entry.login]} />
          )}
        </div>
      )}
    </li>
  );
}

