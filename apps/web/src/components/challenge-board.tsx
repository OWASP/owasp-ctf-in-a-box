// A flag-graded module's board — a category-grouped TILE GRID (issue #208),
// not a column of inline forms. Each tile is just title + points + solved
// state; opening one navigates to the challenge's own page (`basePath` +
// "/<id>": /flags/[id] for classic, /ai/[id] for ai), where the description
// and the flag form live. Twelve challenges already made the inline layout a
// long scroll — a real event's 30–50 would be unusable, and tiles are the
// shape jeopardy-CTF players pick their next target with.
//
// Shared by BOTH flag-graded modules, parameterised only by `basePath` and
// the categories/challenges handed in: a second module gets the same board
// by construction rather than by a copy that drifts.
//
// Server Component on purpose: nothing here is interactive any more — tiles
// are links, and the viewer's solved state arrives as props. The interactive
// surface moved to challenge-detail.tsx.

import Link from "next/link";
import ProgressSummary from "@/components/progress-summary";
import type { ChallengeView } from "@/components/challenge-detail";

// Re-exported so every existing consumer of the view types keeps one import
// path — the types themselves moved with the interactive surface. Both the
// old (classic-only) names and the new generalized names are exported: a
// second module's caller uses ChallengeView/ChallengeStatus, classic's
// existing imports keep working unchanged.
export type { ClassicChallengeView, ClassicStatus, ChallengeView, ChallengeStatus } from "@/components/challenge-detail";

export default function ChallengeBoard({
  categories,
  challenges,
  authenticated,
  hintIds = [],
  basePath,
  runExtras = [],
}: {
  /** The organizer's category display order — categories render in this
   *  order, and a category with no matching challenge is skipped entirely. */
  categories: string[];
  /** Already in the board's reading order (server-sorted); this component
   *  only filters by category, it never re-sorts. */
  challenges: ChallengeView[];
  /** False for a signed-out visitor — the personal progress summary hides
   *  (there is nothing personal to summarize); tiles stay browsable. */
  authenticated: boolean;
  /** Challenge ids with a paid hint on offer — PUBLIC availability (#190),
   *  never text. Drives the tile's 💡 marker; the purchase lives on the
   *  challenge's own page. */
  hintIds?: string[];
  /** Where a tile's link points — classic passes "/flags", a second module
   *  passes its own board route. Tile href is `${basePath}/${encodeURIComponent(challenge.id)}`. */
  basePath: string;
  /** Challenges that count toward the viewer's run rail but render elsewhere
   *  — the OPEN story steps, shown in their lane (#463). Never tiled here. */
  runExtras?: ChallengeView[];
}) {
  // Totals over the RENDERED set — challenges whose category is in the
  // `categories` prop — so the summary can never disagree with the tiles
  // below it (the CodeRabbit finding on the old rail, kept fixed here).
  // Open story steps (#463) render in their lane, not here, but they are part
  // of the viewer's run — counted, never tiled. Locked steps are never passed.
  const rendered = [...challenges.filter((c) => categories.includes(c.category)), ...runExtras];
  const solvedTotal = rendered.filter((c) => c.status === "solved").length;
  const pointsTotal = rendered.reduce((n, c) => n + (c.status === "solved" ? c.earnedPoints : 0), 0);
  const pointsAvailable = rendered.reduce((n, c) => n + c.points, 0);

  return (
    <div className="flex flex-col gap-8">
      {authenticated && rendered.length > 0 && (
        <div className="rounded-lg border border-white/[0.06] bg-[#16162a] px-4 py-3">
          <ProgressSummary
            done={solvedTotal}
            total={rendered.length}
            noun="solved"
            earned={pointsTotal}
            available={pointsAvailable}
          />
        </div>
      )}

      {categories.map((category) => {
        const inCategory = challenges.filter((c) => c.category === category);
        if (inCategory.length === 0) return null; // A category with no challenges is hidden.
        return (
          <section key={category} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-white">{category}</h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {inCategory.map((challenge) => {
                const solved = challenge.status === "solved";
                return (
                  <li key={challenge.id}>
                    <Link
                      href={`${basePath}/${encodeURIComponent(challenge.id)}`}
                      aria-label={`${challenge.title}, ${challenge.points} points${solved ? ", solved" : ""}${hintIds.includes(challenge.id) ? ", paid hint available" : ""}`}
                      className={`ds-card flex h-full min-h-24 flex-col justify-between gap-2 rounded-lg border p-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] ${
                        solved
                          ? "border-[#22c55e]/40 bg-[#22c55e]/[0.08]"
                          : "border-white/[0.06] bg-[#16162a] hover:border-[#2563eb]/40"
                      }`}
                    >
                      <span
                        className={`line-clamp-2 text-sm font-medium ${solved ? "text-[#22c55e]" : "text-white"}`}
                      >
                        {challenge.title}
                        {solved && <span className="sr-only"> (solved)</span>}
                      </span>
                      <span className="flex items-baseline justify-between">
                        <span className={`font-mono text-xs tabular-nums ${solved ? "text-[#22c55e]/80" : "text-muted"}`}>
                          {challenge.points} pts
                          {hintIds.includes(challenge.id) && (
                            <span title="A paid hint is available on this challenge's page." className="ml-1.5">
                              💡
                            </span>
                          )}
                        </span>
                        {solved && (
                          <span aria-hidden className="font-mono text-xs text-[#22c55e]">
                            ✓
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
