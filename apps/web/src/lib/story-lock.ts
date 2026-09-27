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
  storyId: string;
  /** 1-based. */
  position: number;
  total: number;
  /** The step that must be solved first, or null for step 1. */
  prereq: string | null;
};

/** Where every story step sits. A challenge not in any story has no entry. */
export function storyPositions(stories: readonly Story[]): Map<string, StoryPosition> {
  const out = new Map<string, StoryPosition>();
  for (const story of stories) {
    story.steps.forEach((id, i) => {
      out.set(id, {
        storyId: story.id,
        position: i + 1,
        total: story.steps.length,
        prereq: i === 0 ? null : story.steps[i - 1],
      });
    });
  }
  return out;
}

/** Whether a step is locked for a team that has solved `teamSolved`. */
export function isLocked(pos: StoryPosition, teamSolved: ReadonlySet<string>): boolean {
  return pos.prereq !== null && !teamSolved.has(pos.prereq);
}

/** The placeholder a locked step shows instead of anything about itself. */
export function lockedLabel(pos: StoryPosition): string {
  return `??? — step ${pos.position} of ${pos.total}`;
}
