// One name per module, for the panel's own text (audit F25).
//
// The panel had four names for the same two things: a classic solve was a
// "flag solve" in Activity, under a tab called "Jeopardy", while the nav
// said "Flags"; Insights called Secure Development "Sec-dev" and printed the
// raw registry ids `classic` and `ai` in a column headed Module. Same thing,
// four names, on one screen — which costs nothing until an organizer has to
// search their own panel for a word they read a minute ago.
//
// The tab label is canonical, and the tab label is the registry's
// `displayName`. This map is that, in a form the client components can read:
// `lib/modules.ts` is importable from a client component, but its resolved
// module objects deliberately drop `displayName` (see the `ResolvedModule`
// comment there) and neither tab that needs these strings is handed one. The
// duplication is therefore real, and a test pins every entry against the
// registry so it cannot drift.
//
// An event that RENAMES a module from /admin is not covered here: the
// rename reaches the contestant-facing surfaces and the tab, and these two
// admin readouts keep the registry name. Naming them after the registry is
// still strictly better than `ai` and "Sec-dev", and threading a resolved
// module list into Activity and Insights is a bigger change than this finding
// asks for.

import type { ModuleId } from "@/lib/modules";

/** Registry display names, pinned by `__tests__/vocabulary.test.ts`. */
export const MODULE_LABEL: Record<ModuleId, string> = {
  "secure-development": "Secure Development",
  quiz: "Quiz",
  classic: "Jeopardy",
  ai: "AI",
};

/** The module's name, or the id itself for one this build does not know — a
 *  row written by a newer build must still render, the same rule the activity
 *  log applies to unknown event types. */
export function moduleLabel(id: string): string {
  return MODULE_LABEL[id as ModuleId] ?? id;
}
