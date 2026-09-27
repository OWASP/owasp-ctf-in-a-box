// Stories (#463): an ordered chain of classic challenges a TEAM unlocks one
// step at a time. Pure and dependency-free — the board, the challenge page,
// the board-items API and the graders all read the same answer from here.
//
// Unlock is DERIVED, never stored: a step is locked while its immediate
// predecessor is unsolved by the team, computed from current solves on every
// read. A reorder mid-event re-computes; a teammate leaving takes the unlocks
// their solves gave with them. Step 1 of every story is always open.

export type Story = {
  id: string;
  title: string;
  intro: string;
  /** Challenge ids, in order. A challenge belongs to at most one story. */
  steps: string[];
};

export type StoryPosition = {
  /** The step's own challenge id. */
  id: string;
  storyId: string;
  /** 1-based. */
  position: number;
  total: number;
  /** The step that must be solved first, or null for step 1. */
  prereq: string | null;
};

/** Where every story step sits. A challenge not in any story has no entry.
 *
 *  `existing` (the ids of challenges that exist) drops any stale step id first
 *  — a challenge deleted without its story being pruned, or an id that never
 *  existed. Without it, a ghost step nobody can ever solve would lock the step
 *  after it forever. Every caller that knows the challenge list passes it. */
export function storyPositions(stories: readonly Story[], existing?: ReadonlySet<string>): Map<string, StoryPosition> {
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

/** Whether a step is locked for a team that has solved `teamSolved`. A step
 *  the team has ALREADY solved is never locked — a teammate leaving or a
 *  reorder must not hide a solve whose points are banked. */
export function isLocked(pos: StoryPosition, teamSolved: ReadonlySet<string>): boolean {
  if (teamSolved.has(pos.id)) return false;
  return pos.prereq !== null && !teamSolved.has(pos.prereq);
}

/** The placeholder a locked step shows instead of anything about itself. */
export function lockedLabel(pos: StoryPosition): string {
  return `??? — step ${pos.position} of ${pos.total}`;
}
