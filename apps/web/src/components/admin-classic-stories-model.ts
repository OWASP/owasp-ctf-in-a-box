// The /admin story editor's state (#463), kept pure and out of the component
// so every transition is unit-testable and none of them mutates the list it
// was handed. The component holds a `Story[]` draft and swaps it for whatever
// these return; Save POSTs the whole list as `{ stories }`, and the route
// (then `setStories`) is the authority on what is valid.

import type { Story } from "@/lib/story-lock";

const ID_MAX = 64;

/** A story id for `title`: lowercase slug in the store's grammar
 *  (`[a-z0-9][a-z0-9-]{0,63}`), suffixed `-2`, `-3`, ... until no story in
 *  `stories` has it. An id is fixed once made — a rename keeps it, so a
 *  bundle re-import still finds the story it replaces. */
export function storyIdFor(title: string, stories: readonly Story[]): string {
  const stem =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, ID_MAX)
      .replace(/-+$/, "") || "story";
  const taken = new Set(stories.map((st) => st.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${stem.slice(0, ID_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** Appends an empty story titled `title` (trimmed); a blank title is a no-op. */
export function addStory(stories: readonly Story[], title: string): Story[] {
  const t = title.trim();
  if (!t) return stories as Story[];
  return [...stories, { id: storyIdFor(t, stories), title: t, intro: "", steps: [] }];
}

function update(stories: readonly Story[], id: string, fn: (st: Story) => Story): Story[] {
  return stories.map((st) => (st.id === id ? fn(st) : st));
}

export function renameStory(stories: readonly Story[], id: string, title: string): Story[] {
  return update(stories, id, (st) => ({ ...st, title }));
}

export function setIntro(stories: readonly Story[], id: string, intro: string): Story[] {
  return update(stories, id, (st) => ({ ...st, intro }));
}

/** Appends `challengeId` to the story — only when no story holds it yet (a
 *  challenge belongs to one story); otherwise the list comes back unchanged. */
export function addStep(stories: readonly Story[], id: string, challengeId: string): Story[] {
  if (stories.some((st) => st.steps.includes(challengeId))) return stories as Story[];
  return update(stories, id, (st) => ({ ...st, steps: [...st.steps, challengeId] }));
}

/** Swaps step `index` with its neighbour in `dir`; a move past either end
 *  returns the list unchanged. */
export function moveStep(stories: readonly Story[], id: string, index: number, dir: -1 | 1): Story[] {
  const st = stories.find((x) => x.id === id);
  const to = index + dir;
  if (!st || index < 0 || index >= st.steps.length || to < 0 || to >= st.steps.length) return stories as Story[];
  const steps = [...st.steps];
  [steps[index], steps[to]] = [steps[to], steps[index]];
  return update(stories, id, (x) => ({ ...x, steps }));
}

export function removeStep(stories: readonly Story[], id: string, index: number): Story[] {
  return update(stories, id, (st) => ({ ...st, steps: st.steps.filter((_, i) => i !== index) }));
}

export function removeStory(stories: readonly Story[], id: string): Story[] {
  return stories.filter((st) => st.id !== id);
}

/** Drops steps whose challenge is gone. Deleting a challenge already removes
 *  it from its story server-side; this keeps the draft on screen agreeing
 *  with that until the next read, and keeps Save from POSTing a ghost step. */
export function pruneSteps(stories: readonly Story[], existing: ReadonlySet<string>): Story[] {
  return stories.map((st) => ({ ...st, steps: st.steps.filter((step) => existing.has(step)) }));
}

/** The challenge ids no story holds, in `ids` order — the "Add step" options. */
export function freeChallengeIds(stories: readonly Story[], ids: readonly string[]): string[] {
  const held = new Set(stories.flatMap((st) => st.steps));
  return ids.filter((id) => !held.has(id));
}
