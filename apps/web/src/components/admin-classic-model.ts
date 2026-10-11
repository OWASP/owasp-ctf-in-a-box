// The classic admin panel's pure model: the draft/editor/payload types, the
// validation and payload builders, the delete-confirmation copy, the bundle
// export, the category usage count and the row accessors — everything about
// a challenge the panel reasons about without rendering or fetching. Split
// out of admin-classic-controls.tsx (which re-exports all of it) so the
// component file stays readable; see that file's header for the design notes
// these helpers implement.

import type { AdminChallenge, Challenge, ImportSummary } from "@/lib/classic-store";
import type { Story } from "@/lib/story-lock";
import type { AttachmentMeta } from "@/lib/attachments-keys";
import { generateChallengeId, CLASSIC_POINTS_MAX } from "@/lib/classic-keys";
import { CLASSIC_BUNDLE_VERSION, type ClassicBundle } from "@/lib/classic-io";
import { MARKDOWN_MAX } from "@/lib/markdown";
import type { ModuleInventory } from "@/components/admin-module-setup";
import { describeAdminError } from "@/components/admin/fetch";
import { DELETE_CONFIRM_PHRASE_MAX, confirmPhrase } from "@/components/admin/confirm-phrase";
import { categoriesRequestBody } from "@/components/admin/use-category-editor";
import { type RowAccessors, changedOrderRows as changedRows, reorderRows } from "@/components/admin/ordered-rows";

// `CLASSIC_POINTS_MAX` is re-exported (not just imported) because this
// component's OWN test file imports it from here, mirroring how the rest of
// this module's helpers are exported for direct testing.
export { CLASSIC_POINTS_MAX };

/** What this panel tells the shell about its content: challenges AND
 *  categories, because "add a category first" is this board's first setup
 *  step — plus how many challenges the board does not render.
 *
 *  `unlisted` counts rows whose `category` is absent from the stored list.
 *  The membership test is EXACT equality because that is what
 *  `challenge-board.tsx` filters on: a challenge spelled "web" against a
 *  stored "Web" is invisible there, so it has to be counted here (#344).
 *  Pure; exported for direct testing. */
export function classicInventory(rows: readonly AdminChallenge[], categories: readonly string[]): ModuleInventory {
  return { items: rows.length, categories: categories.length, unlisted: unlistedCount(rows, categories) };
}

/** Rows the board will not render, because their category is not in the list.
 *  Shared shape with ai's, kept as one implementation here and imported there
 *  — the two boards filter identically, so one drifting from the other would
 *  mean one panel warning where the other stays quiet. */
export function unlistedCount(
  rows: readonly { challenge: { category: string } }[],
  categories: readonly string[],
): number {
  const listed = new Set(categories);
  return rows.reduce((n, row) => (listed.has(row.challenge.category) ? n : n + 1), 0);
}

/** Maps a `/api/admin/classic` response to a message that tells a validation
 *  failure (the organizer's payload was bad — 400) apart from an
 *  infrastructure failure (the store itself is unavailable — 503), mirroring
 *  `describeQuizError`. */
export function describeClassicError(status: number, message?: string): string {
  return describeAdminError(status, message, "That didn't work — check the challenge and try again.");
}

export { DELETE_CONFIRM_PHRASE_MAX };

/** The exact string the delete confirmation makes the organizer type: the
 *  challenge's title through the shared `confirmPhrase`, falling back to
 *  `fallbackId` for a blank/whitespace-only title.
 *
 *  That fallback is the whole guard: `ConfirmModal` treats an empty
 *  `requireType` as "no confirmation required" (ConfirmModal's own comment),
 *  so a challenge whose title is empty or all whitespace would otherwise
 *  delete on a single click with no typed confirmation at all. `fallbackId`
 *  is always non-empty (`CLASSIC_ID_RE` requires 1-64 chars), so the guard
 *  can never itself produce the empty string it exists to avoid. Exported
 *  for direct testing. */
export function confirmPhraseFromTitle(title: string, fallbackId: string): string {
  return confirmPhrase(title, fallbackId);
}

/** The exact copy + gating for the delete confirmation. Mirrors
 *  `questionDeleteConfirm`: the phrase is the challenge's TITLE (falling back
 *  to its id — see `confirmPhraseFromTitle`), never its id by preference,
 *  because reading the id back proves only that the organizer can copy a
 *  string, not that they know WHICH challenge is about to disappear. The id
 *  still appears in `body` as a fact, since two challenges can share a title
 *  prefix. Exported for direct testing. */
export function challengeDeleteConfirm(challenge: Challenge): {
  title: string;
  body: string;
  requireType: string;
  confirmLabel: string;
} {
  const phrase = confirmPhraseFromTitle(challenge.title, challenge.id);
  return {
    title: `Delete "${phrase}"?`,
    body:
      `This removes the challenge (id ${challenge.id}) from the board and hides it from contestants. ` +
      "Points already banked for it stay on the leaderboard — to clear those, use the master reset.",
    requireType: phrase,
    confirmLabel: "Delete challenge",
  };
}

/** Everything about a challenge that the FORM may change.
 *
 *  Deliberately missing: `id` and `order`, mirroring `QuestionDraft` — both
 *  are storage plumbing derived elsewhere, and their absence here is what
 *  makes "an edit cannot change a challenge's id" a property of the types
 *  rather than of a `disabled` attribute somebody could remove. */
export type ChallengeDraft = {
  title: string;
  category: string;
  description: string;
  points: string;
  flag: string;
  /** Compare the flag with capitalisation intact (issue #193). A plain boolean
   *  rather than the string every other field here is: those are strings
   *  because a number input can hold "" mid-edit, which a checkbox cannot. */
  caseSensitive: boolean;
  /** Optional paid-hint text (#190). Empty = no hint (saving clears it). */
  hint: string;
};

/** The form's whole state: the editable draft plus the identity/position the
 *  form does not own. A discriminated union rather than `{ id?: string }`, so
 *  the id is reachable only after establishing which case you are in — a NEW
 *  challenge genuinely has no id yet (minted from the title at save time),
 *  and an EXISTING one's is fixed. */
export type ChallengeEditor =
  | { mode: "new"; order: number; draft: ChallengeDraft }
  | { mode: "edit"; id: string; order: number; draft: ChallengeDraft };

/** The POST body `/api/admin/classic` parses for a challenge upsert. Mirrors
 *  that route's `ChallengePayload` (its exported `CHALLENGE_KEYS` names the
 *  exact key set) — this type just keeps the client from assembling something
 *  obviously wrong. */
export type ChallengePayload = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  flag: string;
  caseSensitive?: boolean;
  hint?: string;
};

export function emptyDraft(defaultCategory: string = ""): ChallengeDraft {
  return { title: "", category: defaultCategory, description: "", points: "10", flag: "", caseSensitive: false, hint: "" };
}

/** A brand-new challenge, positioned at the end of the list. No id: one is
 *  generated from the finished title when the draft is submitted. */
export function newChallengeEditor(nextOrder: number, defaultCategory: string = ""): ChallengeEditor {
  return { mode: "new", order: nextOrder, draft: emptyDraft(defaultCategory) };
}

/** Seeds an edit draft from an existing challenge — INCLUDING its flag, which
 *  is the whole point of taking an `AdminChallenge` here rather than a bare
 *  `Challenge`. Starting a typo fix with a blank flag box forces the
 *  organizer to retype the whole thing from memory, and a mistake there
 *  silently redefines what counts as solved for every contestant. */
export function draftFromChallenge({ challenge: c, flag, hint }: AdminChallenge): ChallengeDraft {
  return {
    title: c.title,
    category: c.category,
    description: c.description,
    points: String(c.points),
    flag,
    hint: hint ?? "",
    // Coerced, because the stored field is absent-when-false and a checkbox
    // needs a real boolean — an `undefined` here makes React switch the input
    // from controlled to uncontrolled the first time it is ticked.
    caseSensitive: c.caseSensitive === true,
  };
}

/** Opens an existing challenge for editing: its draft, plus the id and order
 *  the form cannot touch. */
export function editorFromChallenge(row: AdminChallenge): ChallengeEditor {
  return { mode: "edit", id: row.challenge.id, order: row.challenge.order, draft: draftFromChallenge(row) };
}

/** Whether `draft` could be submitted as-is, mirroring the store's own rules
 *  (`upsertChallenge`) PLUS basic form hygiene, so an organizer can't build
 *  something the store would reject and only find out on submit.
 *
 *  `categories` is the CURRENT category list — a category the organizer
 *  removed after opening this draft must fail validation rather than silently
 *  resubmit a now-unknown one. Exported for direct testing. */
export function isDraftValid(d: ChallengeDraft, categories: readonly string[]): boolean {
  if (d.title.trim().length === 0) return false;
  if (!categories.includes(d.category)) return false;
  if (d.description.length > MARKDOWN_MAX) return false;

  const points = Number(d.points);
  if (d.points.trim() === "" || !Number.isInteger(points) || points < 0 || points > CLASSIC_POINTS_MAX) return false;

  if (d.flag.trim().length === 0) return false;

  return true;
}

/** The POST body for an editor's current state.
 *
 *  The id rule mirrors `payloadFromEditor` in admin-quiz-controls.tsx: on
 *  `mode: "edit"` it is `editor.id`, full stop — never re-derived from a
 *  (possibly just-rewritten) title, because changing an id would orphan every
 *  solve already recorded against the old one. On `mode: "new"` it is minted
 *  from the title.
 *
 *  `newId` is injectable so a test can pin the generated value; production
 *  always uses `generateChallengeId`. Exported for direct testing. */
export function payloadFromEditor(
  editor: ChallengeEditor,
  newId: (title: string) => string = generateChallengeId,
): ChallengePayload {
  const d = editor.draft;
  const title = d.title.trim();
  return {
    id: editor.mode === "edit" ? editor.id : newId(title),
    title,
    category: d.category,
    description: d.description,
    points: Number(d.points),
    order: editor.order,
    flag: d.flag,
    // The hint is ALWAYS sent: an emptied field is a deliberate clear, and
    // the store deletes the row for an empty string (#190).
    hint: d.hint,
    // Sent only when true, matching the route's parser and the store's stored
    // shape — one challenge has one representation whichever door it came
    // through, so an unchanged challenge re-saved from this form produces a
    // byte-identical record.
    ...(d.caseSensitive ? { caseSensitive: true as const } : {}),
  };
}

/** The POST body that re-saves an existing row unchanged apart from whatever
 *  the caller already rewrote on it — used by the reorder path, which changes
 *  `order` and nothing else. Goes through the same endpoint (and therefore
 *  the same validation and audit line) as an edit. Carries the row's own
 *  flag: the upsert endpoint requires `flag` as one of `CHALLENGE_KEYS`, and a
 *  reorder must not silently blank or rewrite it. */
export function payloadFromRow({ challenge: c, flag, hint }: AdminChallenge): ChallengePayload {
  // The hint and `caseSensitive` ride along for the same reason the flag
  // does: a reorder re-saves the row through the same endpoint, and omitting
  // a field would clear state the organizer never touched — the route stores
  // an absent `caseSensitive` as false, so a drag used to downgrade a
  // case-sensitive challenge's grading (#279). Present only when true,
  // matching the route's parser and the stored shape.
  return {
    id: c.id,
    title: c.title,
    category: c.category,
    description: c.description,
    points: c.points,
    order: c.order,
    flag,
    hint: hint ?? "",
    ...(c.caseSensitive ? { caseSensitive: true as const } : {}),
  };
}

/** Where a classic row keeps its id and position — the one thing that
 *  distinguishes this panel's list arithmetic from quiz's (see
 *  components/admin/ordered-rows.ts). */
export const CHALLENGE_ROWS: RowAccessors<AdminChallenge> = {
  id: (row) => row.challenge.id,
  order: (row) => row.challenge.order,
  withOrder: (row, order) => ({ ...row, challenge: { ...row.challenge, order } }),
};

/** Moves the row at `from` to index `to` and rewrites EVERY row's `order`
 *  from its new position (1-based) — the shared `reorderRows` over classic
 *  rows. Pure and exported so the drag handlers and Move up/down buttons only
 *  ever work out a pair of indices. */
export function reorderChallenges(list: readonly AdminChallenge[], from: number, to: number): AdminChallenge[] {
  return reorderRows(list, from, to, CHALLENGE_ROWS);
}

/** The rows whose `order` differs between two versions of the list — exactly
 *  the challenges a reorder has to write back. Matched by challenge id. */
export function changedOrderRows(before: readonly AdminChallenge[], after: readonly AdminChallenge[]): AdminChallenge[] {
  return changedRows(before, after, CHALLENGE_ROWS);
}

/** The exact request body a categories POST sends: EXACTLY one key,
 *  `categories`. This is the whole client-side half of the wire contract
 *  Task 7's route pins (`POST /api/admin/classic` dispatches on
 *  `Object.keys(body).length === 1 && keys[0] === "categories"`) — the
 *  route's exported `CATEGORIES_KEYS` names the same single key. A second key
 *  here, however added, would silently fall through to the challenge-upsert
 *  parser and get rejected with a 400 rather than replacing the category
 *  list. Built once, in `useCategoryEditor` (components/admin), and
 *  re-exported here so a test can drive it straight into the real route (see
 *  the route-level wire-contract test in this component's test file). */
export { categoriesRequestBody };

/** How many challenges currently file under `category` — what lets category
 *  removal refuse with an exact count instead of a vague warning, and what
 *  makes that refusal possible at all: `setCategories` (classic-store.ts)
 *  does not itself check for references, so this component is the only place
 *  that does. Exported for direct testing. */
export function categoryUsageCount(challenges: readonly AdminChallenge[], category: string): number {
  return challenges.filter((row) => row.challenge.category === category).length;
}

/** Builds a bundle from the board this component already holds — `rows`
 *  (each carrying its flag, same as `payloadFromRow`'s input) and the current
 *  category list — so the export button's download handler is a thin
 *  binding around a pure function, the same shape `payloadFromEditor`/
 *  `reorderChallenges` are pure for the same reason: `renderToStaticMarkup`
 *  cannot exercise a click handler, so the logic worth testing has to live
 *  outside one. Mirrors `exportBundle` in classic-store.ts field for field —
 *  that one reads the store server-side; this one reads client state — so an
 *  export built here round-trips through `parseBundle` exactly like a
 *  server-side export would. Exported for direct testing. */
export function exportBundleFrom(
  rows: readonly AdminChallenge[],
  categories: readonly string[],
  stories: readonly Story[] = [],
  attachments: Readonly<Record<string, readonly AttachmentMeta[]>> = {},
): ClassicBundle {
  // A step must name a challenge in the same file, or parseBundle refuses
  // the file this function just wrote (#463). The store drops a deleted
  // challenge from its story too; this is the same rule at the client door.
  const exported = new Set(rows.map((r) => r.challenge.id));
  return {
    version: CLASSIC_BUNDLE_VERSION,
    categories: [...categories],
    stories: stories.map((st) => ({ ...st, steps: st.steps.filter((step) => exported.has(step)) })),
    challenges: rows.map(({ challenge: c, flag, hint }) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      description: c.description,
      points: c.points,
      order: c.order,
      flag,
      // Present-only-when-set, mirroring the server's exportBundle exactly —
      // this client-side path silently DROPPED both fields (CodeRabbit on
      // #210 caught hint; caseSensitive had the same latent hole), and a
      // re-import of such a bundle downgrades grading and deletes hints.
      ...(c.caseSensitive ? { caseSensitive: true as const } : {}),
      ...(hint ? { hint } : {}),
      // #186: metadata only, and only when present — the server export's rule.
      ...(attachments[c.id]?.length ? { attachments: [...attachments[c.id]] } : {}),
    })),
  };
}

/** Formats an `ImportSummary` into the panel's after-import message. Pure for
 *  the same reason `exportBundleFrom` just above is: `importResult` is
 *  `useState`, which `renderToStaticMarkup` can never reach, so the
 *  pluralization branch (and the created/updated interpolation next to it)
 *  has to live outside a render tree to be exercised by a test at all.
 *  Exported for direct testing. */
export function formatImportSummary({ created, updated, categories, stories }: ImportSummary): string {
  const categoryWord = categories === 1 ? "category" : "categories";
  // `stories` is present only for a v2 file (#463); a v1 summary reads as before.
  const storyPart = stories === undefined ? "" : `, ${stories} ${stories === 1 ? "story" : "stories"}`;
  return `Imported: ${created} created, ${updated} updated. (${categories} ${categoryWord}${storyPart} listed in the file.)`;
}

/** One challenge's solve counts as GET /api/admin/classic sends them (#595):
 *  teams (the board's figure) and players; null where a count was unread. */
export type ChallengeSolves = { teams: number | null; players: number | null };

/** The list row's solve figure: "3 teams · 5 players", "unsolved" when
 *  nobody has, so a flag nobody can solve stands out; only what is known when
 *  a count was unread; null when nothing is. */
export function solvesLabel(solves: ChallengeSolves | undefined): string | null {
  if (!solves) return null;
  const { teams, players } = solves;
  if (teams === 0 && players === 0) return "unsolved";
  const parts = [
    teams === null ? null : `${teams} team${teams === 1 ? "" : "s"}`,
    players === null ? null : `${players} player${players === 1 ? "" : "s"}`,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : null;
}
