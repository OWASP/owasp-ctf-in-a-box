// The ai admin panel's pure model: the draft/editor/payload types, the
// validation and payload builders, the delete-confirmation copy, the mode
// labels, the cooldown commit binding, the category usage count and the row
// accessors — everything about an ai challenge the panel reasons about
// without rendering or fetching. Split out of admin-ai-controls.tsx (which
// re-exports all of it) so the component file stays readable; see that
// file's header for the design notes these helpers implement.

import { AI_POINTS_MAX, generateChallengeId, validateUrlTemplate, type AiMode } from "@/lib/ai-keys";
import type { AdminAiChallenge, AiChallenge } from "@/lib/ai-store";
import { MARKDOWN_MAX } from "@/lib/markdown";
import type { ModuleInventory } from "@/components/admin-module-setup";
import { unlistedCount } from "@/components/admin-classic-model";
import { describeAdminError } from "@/components/admin/fetch";
import { confirmPhrase } from "@/components/admin/confirm-phrase";
import { categoriesRequestBody } from "@/components/admin/use-category-editor";
import type { RowAccessors } from "@/components/admin/ordered-rows";

export type NumericSettingKey = "aiCooldownSec";

/** What this panel tells the shell about its content — mirrors
 *  `classicInventory`, including the `unlisted` count of challenges the board
 *  does not render, through that module's shared helper so the two boards
 *  cannot disagree about what counts as unreachable. Pure; exported for
 *  direct testing. */
export function aiInventory(rows: readonly AdminAiChallenge[], categories: readonly string[]): ModuleInventory {
  return { items: rows.length, categories: categories.length, unlisted: unlistedCount(rows, categories) };
}

/** Maps a `/api/admin/ai` response to a message that tells a validation
 *  failure (the organizer's payload was bad — 400) apart from an
 *  infrastructure failure (the store itself is unavailable — 503). Mirrors
 *  `describeClassicError`/`describeQuizError` — each module owns its own copy
 *  of this tiny mapping rather than sharing one, same convention as those. */
export function describeAiError(status: number, message?: string): string {
  return describeAdminError(status, message, "That didn't work — check the challenge and try again.");
}

/** The exact copy + gating for the delete confirmation. The phrase is the
 *  challenge's TITLE (falling back to its id via the shared `confirmPhrase` —
 *  see that function's own doc comment for why the fallback exists at all:
 *  `ConfirmModal` treats an empty `requireType` as "no confirmation
 *  required"). Exported for direct testing. */
export function aiChallengeDeleteConfirm(challenge: AiChallenge): {
  title: string;
  body: string;
  requireType: string;
  confirmLabel: string;
} {
  const phrase = confirmPhrase(challenge.title, challenge.id);
  return {
    title: `Delete "${phrase}"?`,
    body:
      `This removes the challenge (id ${challenge.id}) from the board and hides it from contestants, ` +
      "and revokes its signing key immediately — any external integration still using it will start failing. " +
      "Points already banked for it stay on the leaderboard — to clear those, use the master reset.",
    requireType: phrase,
    confirmLabel: "Delete challenge",
  };
}

/** Everything about a challenge that the FORM may change.
 *
 *  Deliberately missing: `id`. `order` is here (unlike classic's
 *  `ChallengeDraft`) because this panel has no drag-reorder UI — see the
 *  header comment — so position is just another number the form edits. */
export type AiChallengeDraft = {
  title: string;
  category: string;
  description: string;
  points: string;
  order: string;
  /** flag / event / both — see AiMode in ai-keys.ts. */
  mode: AiMode;
  /** The external launch template, containing `{token}`. Validated live with
   *  `validateUrlTemplate` — the same function the store runs. */
  urlTemplate: string;
  flag: string;
  /** Compare the flag with capitalisation intact, mirroring classic's field
   *  (issue #193). Meaningless (and hidden) in event mode. */
  caseSensitive: boolean;
  /** Optional paid-hint text, identical to classic's: empty = no hint, and
   *  saving an emptied field is a deliberate CLEAR, not "leave unchanged". */
  hint: string;
};

/** The form's whole state: the editable draft plus the identity the form
 *  does not own. Mirrors classic's `ChallengeEditor` discriminated union —
 *  an id is reachable only after establishing which case you are in, so an
 *  existing challenge's id can never be expressed as editable. */
export type AiChallengeEditor =
  | { mode: "new"; draft: AiChallengeDraft }
  | { mode: "edit"; id: string; draft: AiChallengeDraft };

/** The POST body `/api/admin/ai` parses for a challenge upsert. Mirrors that
 *  route's `ChallengePayload` (its exported `CHALLENGE_KEYS` names the exact
 *  key set) — this type just keeps the client from assembling something
 *  obviously wrong. `flag`/`caseSensitive` are optional in the TYPE because
 *  the route allows omitting them; in practice `hint` is always sent (see
 *  `payloadFromAiEditor`), same as classic. */
export type AiChallengePayload = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  mode: AiMode;
  urlTemplate: string;
  flag?: string;
  caseSensitive?: boolean;
  hint?: string;
};

/** The cooldown field's `onBlur` handler logic, pulled out as a pure
 *  function so a test can prove the EXACT key wired to `commitNumber`
 *  without needing to simulate a real blur event — this repo's component
 *  tests render with `renderToStaticMarkup`, which never fires DOM events
 *  (see this file's test file header comment). */
export const AI_COOLDOWN_LABEL = "Submission cooldown (sec)";

export function commitAiCooldown(
  commitNumber: (key: NumericSettingKey, raw: string, reset: (v: string) => void, label: string) => void,
  raw: string,
  reset: (v: string) => void,
): void {
  commitNumber("aiCooldownSec", raw, reset, AI_COOLDOWN_LABEL);
}

export function emptyAiDraft(defaultCategory: string = "", nextOrder: number = 1): AiChallengeDraft {
  return {
    title: "",
    category: defaultCategory,
    description: "",
    points: "10",
    order: String(nextOrder),
    mode: "flag",
    urlTemplate: "",
    flag: "",
    caseSensitive: false,
    hint: "",
  };
}

/** A brand-new challenge. No id: one is generated from the finished title
 *  when the draft is submitted. */
export function newAiChallengeEditor(nextOrder: number, defaultCategory: string = ""): AiChallengeEditor {
  return { mode: "new", draft: emptyAiDraft(defaultCategory, nextOrder) };
}

/** Seeds an edit draft from an existing challenge — INCLUDING its flag, for
 *  the same reason classic's `draftFromChallenge` does: an organizer fixing a
 *  typo should never have to retype a flag from memory. */
export function draftFromAiChallenge({ challenge: c, flag, hint }: AdminAiChallenge): AiChallengeDraft {
  return {
    title: c.title,
    category: c.category,
    description: c.description,
    points: String(c.points),
    order: String(c.order),
    mode: c.mode,
    urlTemplate: c.urlTemplate,
    flag,
    hint: hint ?? "",
    // Coerced, because the stored field is absent-when-false and a checkbox
    // needs a real boolean — an `undefined` here makes React switch the
    // input from controlled to uncontrolled the first time it is ticked.
    caseSensitive: c.caseSensitive === true,
  };
}

/** Opens an existing challenge for editing: its draft, plus the id the form
 *  cannot touch. */
export function editorFromAiChallenge(row: AdminAiChallenge): AiChallengeEditor {
  return { mode: "edit", id: row.challenge.id, draft: draftFromAiChallenge(row) };
}

/** Whether `draft` could be submitted as-is, mirroring the store's own rules
 *  (`upsertAiChallenge`) PLUS basic form hygiene, so an organizer can't build
 *  something the store would reject and only find out on submit. Unlike
 *  classic's `isDraftValid`, this takes no `categories` list — the category
 *  select only ever offers a value already in the current list, so there is
 *  nothing extra to police here. Exported for direct testing. */
export function isAiDraftValid(draft: AiChallengeDraft): boolean {
  if (draft.title.trim().length === 0) return false;
  if (draft.category.trim().length === 0) return false;
  if (draft.description.length > MARKDOWN_MAX) return false;

  const points = Number(draft.points);
  if (draft.points.trim() === "" || !Number.isInteger(points) || points < 0 || points > AI_POINTS_MAX) return false;

  const order = Number(draft.order);
  if (draft.order.trim() === "" || !Number.isInteger(order) || order < 0) return false;

  if (!validateUrlTemplate(draft.urlTemplate).ok) return false;

  // A flag is required unless the challenge is event-only — mirrors the
  // store's own `graded` rule in `upsertAiChallenge` exactly.
  if (draft.mode !== "event" && draft.flag.trim().length === 0) return false;

  return true;
}

/** The POST body for an editor's current state.
 *
 *  The id rule mirrors `payloadFromEditor` in admin-classic-controls.tsx: on
 *  `mode: "edit"` it is `editor.id`, full stop — never re-derived from a
 *  (possibly just-rewritten) title, because changing an id would orphan every
 *  solve and invalidate every external integration already pinned to the old
 *  one. On `mode: "new"` it is minted from the title.
 *
 *  `flag` is included only when the challenge is graded (`mode !== "event"`)
 *  — the store deletes both flag hashes on an event-mode upsert regardless of
 *  what is sent, so sending a stale value from a form the organizer can no
 *  longer even see would only be confusing, never load-bearing. `caseSensitive`
 *  is likewise omitted in event mode for the same reason: with no flag to
 *  compare, an organizer who set it while the challenge was flag/both-mode and
 *  then flipped to event-mode would otherwise leave `caseSensitive: true`
 *  riding along in the payload and landing stored, semantically orphaned —
 *  a flag-comparison flag with no flag left to apply it to.
 *
 *  `newId` is injectable so a test can pin the generated value; production
 *  always uses `generateChallengeId`. Exported for direct testing. */
export function payloadFromAiEditor(
  editor: AiChallengeEditor,
  newId: (title: string) => string = generateChallengeId,
): AiChallengePayload {
  const d = editor.draft;
  const title = d.title.trim();
  const graded = d.mode !== "event";
  return {
    id: editor.mode === "edit" ? editor.id : newId(title),
    title,
    category: d.category,
    description: d.description,
    points: Number(d.points),
    order: Number(d.order),
    mode: d.mode,
    urlTemplate: d.urlTemplate.trim(),
    // The hint is ALWAYS sent: an emptied field is a deliberate clear, and
    // the store deletes the row for an empty string — identical to classic.
    hint: d.hint,
    ...(graded ? { flag: d.flag } : {}),
    ...(graded && d.caseSensitive ? { caseSensitive: true as const } : {}),
  };
}

/** How many challenges currently file under `category` — mirrors classic's
 *  `categoryUsageCount` exactly (small enough that reimplementing it here
 *  beats importing a function typed against classic's own row shape).
 *  Exported for direct testing. */
export function categoryUsageCount(challenges: readonly AdminAiChallenge[], category: string): number {
  return challenges.filter((row) => row.challenge.category === category).length;
}

/** The exact request body a categories POST sends: EXACTLY `categories` and
 *  `expected` — see the route's header comment for why the shape has to be
 *  this precise. Built once, in `useCategoryEditor` (components/admin); this
 *  binding keeps the name this module's tests drive into the real route. */
export function aiCategoriesRequestBody(
  categories: readonly string[],
  expected: readonly string[],
): { categories: string[]; expected: string[] } {
  return categoriesRequestBody(categories, expected);
}

export const AI_MODE_LABELS: Record<AiMode, string> = {
  flag: "Graded by flag",
  event: "External event only (no flag)",
  both: "Either — flag or external event",
};

/** Where an ai row keeps its id and position (components/admin/ordered-rows.ts). */
export const AI_ROWS: RowAccessors<AdminAiChallenge> = {
  id: (row) => row.challenge.id,
  order: (row) => row.challenge.order,
  withOrder: (row, order) => ({ ...row, challenge: { ...row.challenge, order } }),
};
