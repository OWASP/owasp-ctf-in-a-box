// The team's scoring picture on the profile page: rank, net points, and each
// member's own contribution — the answer to "who has done what", which the
// roster chips in TeamCard deliberately don't carry (they're membership
// controls, not a scoreboard).
//
// Presentational Server Component: the profile page builds the standing and
// member entries from the SAME leaderboard pipeline the public board uses
// (getLeaderboard → withModuleContributions → withTeamStandings →
// withHintPenalties, see profile/team-standing.ts), so this panel can never disagree with the team's public
// row. A member with no scores yet still gets a row — a full roster with an
// honest zero beats a list that silently omits teammates.

import Image from "next/image";
import type { LeaderboardEntry, TeamStanding } from "@/lib/leaderboard/types";
import { moduleVerb } from "@/components/progress/progress-row";

/** Each module's own noun for a completed item, from the shared vocabulary
 *  every progress surface now reads. This map used to be local, name only
 *  three modules, and fall through to "solved" for anything else — so a
 *  member who had played classic AND ai read "3 solved · 3 solved". */
export function memberSummary(entry: LeaderboardEntry | null): string | null {
  if (!entry?.modules) return null;
  const parts = Object.entries(entry.modules)
    .filter(([, p]) => p && p.completed > 0)
    .map(([id, p]) => `${p!.completed} ${moduleVerb(id)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default function TeamProgress({
  standing,
  memberEntries,
  viewerLogin,
}: {
  standing: TeamStanding;
  /** One entry per roster member, in roster order; null when that member has
   *  no scored activity yet. */
  memberEntries: { login: string; entry: LeaderboardEntry | null }[];
  viewerLogin: string;
}) {
  const rows = [...memberEntries].sort((a, b) => (b.entry?.points ?? 0) - (a.entry?.points ?? 0));
  const memberSum = rows.reduce((n, r) => n + (r.entry?.points ?? 0), 0);
  const showDedupeNote = rows.length > 1 && memberSum > standing.points;

  return (
    <section
      aria-label="Team progress"
      className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Team progress
        </h2>
        <p className="font-mono text-sm tabular-nums">
          {standing.rank > 0 && <span className="text-[#14b8a6]">#{standing.rank}</span>}
          <span className="ml-2 font-bold text-white">
            {standing.points.toLocaleString("en-US")} pts
          </span>
          {typeof standing.hintPenalty === "number" && standing.hintPenalty > 0 && (
            <span className="ml-2 text-xs text-[#d4a017]">−{standing.hintPenalty} hints</span>
          )}
        </p>
      </div>

      <ul className="mt-4 flex flex-col">
        {rows.map(({ login, entry }) => (
          <li
            key={login}
            className="flex items-center gap-3 border-b border-white/[0.04] py-2 last:border-b-0"
          >
            <Image
              src={`https://avatars.githubusercontent.com/${login}`}
              alt=""
              width={28}
              height={28}
              className="flex-none rounded-full border border-white/10"
              unoptimized
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm text-white">
                {login}
                {login === viewerLogin && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-[#2563eb]">you</span>
                )}
                {login === standing.captain && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-[#d4a017]">captain</span>
                )}
              </p>
              {memberSummary(entry) && (
                <p className="truncate text-xs text-muted">{memberSummary(entry)}</p>
              )}
            </div>
            <p className="flex-none font-mono text-sm font-semibold tabular-nums text-white">
              {(entry?.points ?? 0).toLocaleString("en-US")}
              <span className="ml-1 text-xs font-normal text-muted">pts</span>
            </p>
          </li>
        ))}
      </ul>

      {/* Team totals fold the UNION of members' solves — a flag two members
          both solve banks once. Said out loud, because the alternative is a
          captain adding up the member column and reporting a scoring bug. */}
      {showDedupeNote && (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Members&rsquo; points add up to {memberSum.toLocaleString("en-US")} — the team banks each
          solve once, so shared solves don&rsquo;t double-count.
        </p>
      )}
    </section>
  );
}
