// The denominator rule, in ONE place, because it has now been filed as a bug
// three times (#330, #343, #348) and each time the fix reached one caller and
// stopped there. It lived in `profile/module-blocks.ts`, which the leaderboard
// cannot reach — so the two surfaces disagreed about the same contestant's
// same module until someone noticed and filed it again.
//
// Story-lock reachability (#570): classic stories are ordered chains where step
// 1 is always reachable and each later step unlocks only when the previous
// step is solved by the team. Locked steps' titles and points must never be
// exposed. The reachable denominator is computed from the team's solved IDs
// using the same logic as `lib/story-lock.ts`, so the profile, the leaderboard
// team row, and the graders all agree on what is reachable. A teamless
// contestant sees only step 1 of each story.
//
// The rule: a module's numerator counts SOLVE RECORDS, which survive deletion
// on purpose — the admin delete dialog promises it ("Points already banked for
// it stay on the leaderboard"). Its denominator therefore cannot be the live
// catalogue alone, or every deleted-but-solved item splits the two and a row
// reads "5 / 5 cleared" for a module that still has two challenges open, or
// worse "870 / 850 pts" with a bar filled past its own end.
//
// So the denominator is the UNION, counted by IDENTITY: the live catalogue plus
// any solved item whose challenge is gone.
//
// Clamping is NOT this rule and does not substitute for it. `Math.max(live,
// solved)` stops a ratio exceeding one, which is why `atLeast` is still the
// right answer where per-item identity does not exist — secure-development's
// catalogue is baked from the rubrics, and the aggregate per-login counters are
// running totals with no memory of which items produced them. But it reports
// 5 / 5 where the truth is 5 / 7: it tells a contestant they have finished a
// module they have not. Reach for it only when there are no ids to union.
//
// Pure and client-safe: no store access, no server-only imports. The profile
// draws its rows from a Server Component and the leaderboard's team row from a
// Client one, and both have to be able to reach this.

/** A denominator that can never be smaller than its own numerator — the
 *  fallback for a caller with no per-item identity to union over. Prefer
 *  `unionTotal`/`unionDenominators` wherever ids exist; see the header. */
export function atLeast(total: number, done: number): number {
  return Math.max(total, done);
}

/** The union's item COUNT, for a caller that has ids but no per-item points:
 *  the live catalogue, plus every solved id missing from it.
 *
 *  This is the leaderboard team row's form. Its fold already dedupes members'
 *  solves by item id, so the ids are in hand and the union costs nothing
 *  beyond this loop — no extra Redis round trip, which is what kept the board
 *  on a live-only count in the first place (#348).
 *
 *  `liveIds` empty means the catalogue read FAILED, not that the board is
 *  empty — the leaderboard degrades a failed list read to a missing
 *  denominator on purpose, never to lost points. Every solve would otherwise
 *  count as an orphan and the row would read "5 / 5" by a different accident,
 *  so fall back to the solve count and let the caller clamp. */
export function unionTotal(liveIds: ReadonlySet<string>, solvedIds: readonly string[]): number {
  if (liveIds.size === 0) return solvedIds.length;
  let total = liveIds.size;
  for (const id of solvedIds) if (!liveIds.has(id)) total += 1;
  return total;
}

/** The union's item count AND its points ceiling, for a caller holding the
 *  per-item solve records — the profile's form.
 *
 *  Points for a gone item come from the SOLVE RECORD, not the catalogue:
 *  `points` there is what the item was worth AT SOLVE TIME, which is the only
 *  figure a deleted challenge still has, and the one already banked on the
 *  leaderboard. */
export function unionDenominators(
  live: readonly { id: string; points?: number }[],
  solved: Readonly<Record<string, { points?: number }>>,
): { total: number; max: number } {
  const liveIds = new Set(live.map((item) => item.id));
  let total = live.length;
  let max = live.reduce((sum, item) => sum + (Number(item.points) || 0), 0);
  for (const [id, solve] of Object.entries(solved)) {
    if (liveIds.has(id)) continue;
    total += 1;
    max += Number(solve?.points) || 0;
  }
  return { total, max };
}

export type Story = {
  id: string;
  title: string;
  intro: string;
  steps: string[];
};

type StoryPosition = {
  id: string;
  storyId: string;
  position: number;
  total: number;
  prereq: string | null;
};

function storyPositions(stories: readonly Story[], existing?: ReadonlySet<string>): Map<string, StoryPosition> {
  const out = new Map<string, StoryPosition>();
  for (const story of stories) {
    const steps = existing ? story.steps.filter((id) => existing.has(id)) : story.steps;
    steps.forEach((id, i) => {
      out.set(id, {
        id,
        storyId: story.id,
        position: i + 1,
        total: steps.length,
        prereq: i === 0 ? null : steps[i - 1],
      });
    });
  }
  return out;
}

function isLocked(pos: StoryPosition, teamSolved: ReadonlySet<string>): boolean {
  if (teamSolved.has(pos.id)) return false;
  return pos.prereq !== null && !teamSolved.has(pos.prereq);
}

/** Reachable classic denominator for a team (or a solo contestant).
 *
 *  A story step is REACHABLE when:
 *    - it is step 1 of its story, OR
 *    - its prerequisite step is in `teamSolved`.
 *
 *  Locked steps are excluded from both the count and the points ceiling —
 *  their titles and points must never leak. A teamless contestant (empty
 *  `teamSolved`) sees only step 1 of each story.
 *
 *  The union with `solved` is still applied: a step solved by the team but
 *  since deleted from the catalogue is counted in `total` and its points from
 *  the solve record are added to `max`. A step that is locked for the team
 *  but appears in `solved` (a teammate left, or a reorder) is treated as
 *  reachable — banked points are never hidden.
 *
 *  Returns { total, max, locked } where:
 *    - total: reachable live steps + solved-but-deleted steps
 *    - max:   points of reachable live steps + points of solved-but-deleted steps
 *    - locked: number of live steps that are locked for this team */
export function classicReachableDenominator(
  challenges: readonly { id: string; points?: number }[],
  stories: readonly Story[],
  teamSolved: ReadonlySet<string>,
  solved: Readonly<Record<string, { points?: number }>>,
): { total: number; max: number; locked: number } {
  const existing = new Set(challenges.map((c) => c.id));
  const positions = storyPositions(stories, existing);
  const liveById = new Map(challenges.map((c) => [c.id, c]));
  const liveIds = new Set(liveById.keys());

  // First pass: classify live steps as reachable or locked.
  let total = 0;
  let max = 0;
  let locked = 0;
  for (const challenge of challenges) {
    const pos = positions.get(challenge.id);
    if (!pos) {
      // Not in a story: always reachable.
      total += 1;
      max += Number(challenge.points) || 0;
      continue;
    }
    if (isLocked(pos, teamSolved)) {
      locked += 1;
      continue;
    }
    // Reachable (step 1, or prereq solved, or already solved by team).
    total += 1;
    max += Number(challenge.points) || 0;
  }

  // Second pass: add solved-but-deleted steps from solve records (union with solve records).
  for (const [id, solve] of Object.entries(solved)) {
    if (liveIds.has(id)) continue;
    // A solved step that was in a story but is now deleted: its prereq no
    // longer exists, so it cannot be locked — count it as reachable.
    total += 1;
    max += Number(solve?.points) || 0;
  }

  // Third pass: add solved-but-deleted steps that are in teamSolved but not in solve records.
  // This handles the case where the fold provides itemIds for deleted items but not itemPoints.
  for (const id of teamSolved) {
    if (liveIds.has(id)) continue;
    if (solved[id]) continue; // already counted in second pass
    // Deleted item solved by team but not in solve records (no points available).
    total += 1;
    // max unchanged (0 points)
  }

  return { total, max, locked };
}
