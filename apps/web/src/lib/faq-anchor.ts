// Maps a URL hash to the index of the FAQ item carrying that id, so a deep link
// like /faq#<id> can open the right accordion panel.
//
// Deliberately pure and DOM-free: vitest runs `environment: "node"` in this repo
// and there is no component-test harness, so the matching logic lives here where
// it can be unit-tested rather than inside the client accordion.

/** The only shape matching needs. The accordion's `QA` type satisfies this
 *  structurally, so callers don't have to import `QA` here. */
type AnchoredItem = { id?: string };

/** Index of the item whose `id` equals `hash`, or null when nothing matches.
 *  Tolerates a leading "#", an empty or absent hash, and items without ids. */
export function indexForHash(
  items: readonly AnchoredItem[],
  hash: string | undefined,
): number | null {
  if (!hash) return null;
  const target = hash.startsWith("#") ? hash.slice(1) : hash;
  // Guard the bare "#" case: without this, `item.id === ""` could match, and an
  // item with no id at all would compare undefined against "" — close enough to
  // a bug to rule out explicitly.
  if (!target) return null;
  const index = items.findIndex((item) => item.id === target);
  return index === -1 ? null : index;
}
