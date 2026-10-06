"use client";

// The ai (externally hosted AI/LLM) module's admin section: the submission-
// cooldown knob plus challenge authoring (add/edit/delete) and category
// management, rendered in place of admin-controls.tsx's old "No settings for
// this module yet." placeholder for the ai module. Modeled on
// admin-classic-controls.tsx — same shape of problem (list, editor form,
// category manager, delete confirmation) — kept deliberately SMALLER, with
// the differences ai's own shape forces:
//
//   - A challenge has a `mode` (flag / event / both — see AiMode in
//     ai-keys.ts) and a `urlTemplate` (the external launch link, containing
//     `{token}`), neither of which classic has at all.
//   - `mode === "event"` means the box stores no flag for that challenge —
//     the store DELETES both flag hashes on an event-mode upsert (see
//     `upsertAiChallenge`'s doc comment) — so the form hides the flag and
//     case-sensitivity inputs in that mode rather than rendering controls for
//     fields that would silently be discarded.
//   - The launch URL is validated with `validateUrlTemplate` from
//     `@/lib/ai-keys` — the SAME function `upsertAiChallenge` runs
//     server-side — never re-implemented here. Client-side validation is a
//     convenience only; the server re-checks regardless (spec §8.1: enforced
//     both sides, one implementation).
//   - No reordering UI. Classic earned drag-and-drop plus keyboard move
//     buttons because organizers actively curate a long-running board; this
//     panel keeps `order` as a plain editable number instead — simpler code,
//     and nothing in this task calls for parity there.
//   - No per-tab bulk import/export button. Classic's `{import: ...}` POST
//     arm is classic-only; the ai catalogue is carried by the whole-event
//     archive on the Event tab instead (ai-io.ts / event-store.ts, #250).
//   - The wire contract is THREE payload shapes on ONE endpoint
//     (`POST /api/admin/ai`), dispatched by the server on exact key set —
//     see that route's header comment. This component's `aiCategoriesRequestBody`
//     helper exists for the same reason `categoriesRequestBody` exists in
//     the classic component: every categories POST must carry EXACTLY
//     `{categories}` and nothing else.
//   - Categories can be removed only while nothing references them, checked
//     client-side here exactly like classic (`setAiCategories` doesn't
//     enforce it either).
//
// Settings: `aiCooldownSecInput` reuses `commitNumber` from
// admin-controls.tsx exactly like classic's `classicCooldownSecInput`.
//
// Challenges: this component owns its own fetch of GET /api/admin/ai and its
// own add/edit/delete state, independent of the settings machinery above.
// `initialChallenges`/`initialCategories` seed the lists synchronously (used
// by tests, which render with `renderToStaticMarkup` and so never run the
// mount-time fetch below); in the browser they are just the pre-hydration
// paint, immediately replaced by a fresh fetch.
//
// No id field, ever, on the form — mirrors classic exactly. An id is
// generated from the title (`generateChallengeId`, re-exported from
// `@/lib/ai-keys`) when a NEW challenge is saved, and is immutable on an
// existing one: it is the field name in `ctf:ai:challenges`/`ctf:ai:flag`/
// `ctf:ai:flagnorm`/`ctf:ai:signkey` AND the reference every contestant's
// `ctf:ai:solves:<login>` row and every external integration's signing key
// are pinned against.
//
// Secrecy: this component DOES hold the flag AND the signing key — the same
// reasoning as classic's flag (see that file's header comment): `requireAdmin`
// gates the GET before any store read, so anyone past it can already rewrite
// or delete either outright, and prefilling saves an organizer from retyping
// a flag from memory (which risks silently redefining what counts as solved)
// or re-pasting a key into every external integration. The flag input still
// masks (`type="password"`, reveal toggle) for the screen-share case.
//
// The signing key itself is NOT rendered by this component at all — reading
// or rotating it is `AdminAiIntegration`'s job (the per-challenge integration
// panel, imported below), rendered inside every row of the challenge list.
//
// Deletion changes live event data mid-flight, so it is gated behind the
// same `ConfirmModal` + typed-title-confirm pattern classic's challenge
// delete uses, with the shared `confirmPhrase` (components/admin) building
// the typed phrase — title in, safe non-empty phrase out.
//
// What deletion does NOT do: it does not clear contestant history (points
// stay banked — the master reset's job), and it DOES revoke the signing key
// immediately, breaking any external integration still using it — the
// confirm copy below says so.
//
// The pure model (types, validation, payload builders, confirmation copy) is
// in admin-ai-model.ts and the form in admin-ai-form.tsx; both are
// re-exported here so tests and callers keep one import path.
//
// The RENDERING frame this file used to carry — the settings-card slot, the
// category editor wiring, the Challenges panel shell and list, the form and
// both confirmations — is shared with admin-classic-controls.tsx in
// components/admin/challenge-frame.tsx (issue #504). What is returned below
// is ai's own config for that frame.

import { useEffect, useState } from "react";
import { AI_COOLDOWN_SEC } from "@/lib/ai-defaults";
// Type-only import: `ai-store.ts` is `server-only`, but a `import type` is
// fully erased at compile time — no runtime import ever reaches the client
// bundle. Never change this to a value import.
import type { AdminAiChallenge, AiChallenge } from "@/lib/ai-store";
import ChallengeFrame from "@/components/admin/challenge-frame";
import { useCategoryEditor } from "@/components/admin/use-category-editor";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { sendJson } from "@/components/admin/fetch";
import AdminAiIntegration, { AiEndpointsBlock, useBrowserOrigin } from "@/components/admin-ai-integration";
import AiExternalSetup from "@/components/admin-ai-external-setup";
import type { ModuleInventory } from "@/components/admin-module-setup";
import AdminNumberField, { type FieldStatus } from "@/components/admin-number-field";
import type { ModuleSettingsSlot } from "@/components/admin/settings-card";
import { AiChallengeForm } from "@/components/admin-ai-form";
import {
  AI_COOLDOWN_LABEL,
  AI_MODE_LABELS,
  AI_ROWS,
  type AiChallengeEditor,
  type AiChallengePayload,
  type NumericSettingKey,
  aiChallengeDeleteConfirm,
  aiInventory,
  categoryUsageCount,
  commitAiCooldown,
  describeAiError,
  editorFromAiChallenge,
  newAiChallengeEditor,
  payloadFromAiEditor,
} from "@/components/admin-ai-model";

export * from "@/components/admin-ai-model";
export { AiChallengeForm } from "@/components/admin-ai-form";

export type AdminAiControlsProps = {
  /** Parent-wide "a settings POST is in flight" flag — shared with every
   *  other section's inputs, same as classic's cooldown field. */
  pending: boolean;
  aiCooldownSecInput: string;
  setAiCooldownSecInput: (v: string) => void;
  commitNumber: (key: NumericSettingKey, raw: string, reset: (v: string) => void, label: string) => void;
  /** The shell's per-field save status, by stored key (UX audit F2). Optional
   *  so a static render without a shell still works; idle when absent. */
  statusOf?: (key: string) => FieldStatus;
  /** The module screen's settings card slot (identity editor + Hints link);
   *  absent, the knob renders bare — see components/admin/settings-card.tsx. */
  moduleSettings?: ModuleSettingsSlot;
  /** Test/first-paint seed only — see header comment. */
  initialChallenges?: AdminAiChallenge[];
  /** Seeds the loaded flag — same test seam as the two above. */
  initialLoaded?: boolean;
  initialCategories?: string[];
  /** Reports the board's size to the shell for the setup checklist above this
   *  panel — after the mount-time fetch has settled, never from the seed. */
  onInventory?: (inventory: ModuleInventory) => void;
};

export default function AdminAiControls({
  pending,
  aiCooldownSecInput,
  setAiCooldownSecInput,
  commitNumber,
  statusOf = () => ({ state: "idle" }),
  moduleSettings,
  initialChallenges = [],
  initialCategories = [],
  initialLoaded = false,
  onInventory,
}: AdminAiControlsProps) {
  // The board, the category list, the open editor, the delete target and
  // every write over them live in the shared resource hook
  // (components/admin/use-admin-resource.ts). What is ai-shaped is the
  // config: the endpoint, where a row keeps its id/order, how the route's
  // replies map to rows (a signing key rides along), and the payload builder
  // above. No `rowPayload`: this panel has no drag-reorder. The seeds are the
  // first paint; the hook's mount-time GET replaces them in the browser
  // (never under `renderToStaticMarkup`).
  const resource = useAdminResource<AdminAiChallenge, AiChallenge, AiChallengeEditor, AiChallengePayload>({
    endpoint: "/api/admin/ai",
    describeError: describeAiError,
    rows: AI_ROWS,
    parseList: (data) => ({
      rows: Array.isArray(data.challenges) ? (data.challenges as AdminAiChallenge[]) : [],
      categories: Array.isArray(data.categories) ? (data.categories as string[]) : [],
    }),
    loadErrorMessage: "Couldn't load challenges — check your connection and try again.",
    // The route echoes the STORED record (mode/urlTemplate may have been
    // normalized, and a signing key is guaranteed), not the raw payload, so
    // this panel's state matches what a subsequent GET would return.
    parseUpsert: (data, payload) => {
      const challenge = data.challenge as AiChallenge | undefined;
      if (!challenge) return null;
      return {
        challenge,
        flag: (data.flag as string | undefined) ?? (payload.flag ?? ""),
        hint: (data.hint as string | null | undefined) ?? null,
        signingKey: (data.signingKey as string | undefined) ?? "",
      };
    },
    toPayload: payloadFromAiEditor,
    initialRows: initialChallenges,
    initialLoaded,
    initialCategories,
  });
  const { rows: challenges, categories, loaded } = resource;

  // Report upward whenever the board changes, once it is real. A report to
  // the parent's subscriber, not a setState of this component's own.
  useEffect(() => {
    if (loaded) onInventory?.(aiInventory(challenges, categories));
  }, [loaded, challenges, categories, onInventory]);

  // Which challenge's signing key is currently being rotated (driven by
  // `AdminAiIntegration`, the per-challenge integration panel) — at most one
  // at a time, driven per-row by that panel's own `pending` prop
  // (`rotatingId === row.challenge.id`).
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  // Category editing (input, in-flight flag, refusal) and its writes; the
  // list itself is the resource's because the same GET owns it.
  const categoryEditor = useCategoryEditor({
    endpoint: "/api/admin/ai",
    describeError: describeAiError,
    categories,
    setCategories: resource.setCategories,
    usageCount: (name) => categoryUsageCount(challenges, name),
    // A rename rewrites every challenge in the category, so the rows on
    // screen still carry the old name until the list is re-read. Without
    // this the panel keeps grouping them under a heading the store no
    // longer has.
    afterRename: resource.reload,
  });

  /** POST `{rotate: id}` — mints a new signing key for one challenge and
   *  swaps it into the rows from the response, exactly like every other
   *  write in this component echoes the store's own result rather than
   *  something derived client-side. Wired to `AdminAiIntegration`'s
   *  `onRotate` prop at the seam below; errors surface through the same
   *  `describeAiError` idiom every other write in this file uses. ALWAYS
   *  rethrows on failure (network or a non-2xx) so the panel's own confirm
   *  (`confirmRotate` in admin-ai-integration.tsx) knows not to close itself
   *  — an organizer who just saw an error should still see the confirm, not
   *  have it vanish as if the rotate had succeeded. */
  async function rotateSigningKey(id: string): Promise<void> {
    setRotatingId(id);
    setRotateError(null);
    try {
      const result = await sendJson<{ error?: string; signingKey?: string }>(
        "/api/admin/ai",
        { method: "POST", body: { rotate: id } },
        describeAiError,
      );
      if (!result.ok) {
        setRotateError(result.message);
        throw new Error("rotate failed");
      }
      const { status, data } = result;
      if (typeof data.signingKey !== "string") {
        setRotateError(describeAiError(status, data.error));
        throw new Error("rotate failed");
      }
      const signingKey = data.signingKey;
      resource.setRows((prev) => prev.map((row) => (row.challenge.id === id ? { ...row, signingKey } : row)));
    } finally {
      setRotatingId(null);
    }
  }

  // Hydration-safe: "" on the server and on the first browser render, the
  // real origin after — see `useBrowserOrigin`. The per-row panel uses the
  // same hook, so both halves of the integration UI agree.
  const origin = useBrowserOrigin();

  const knob = (
    <AdminNumberField
      id="ai-cooldown-sec"
      label={AI_COOLDOWN_LABEL}
      help="Seconds a contestant must wait between graded flag submissions on the same challenge. 0 = no cooldown. Signed events from the external side are never rate-limited by this — there is no wrong answer to throttle."
      value={aiCooldownSecInput}
      placeholder={String(AI_COOLDOWN_SEC)}
      disabled={pending}
      status={statusOf("aiCooldownSec")}
      onChange={setAiCooldownSecInput}
      onBlur={() => commitAiCooldown(commitNumber, aiCooldownSecInput, setAiCooldownSecInput)}
    />
  );

  // The settings-card slot, the category editor, the Challenges panel
  // (heading, Add, endpoints, list-error line, the list) and the form plus
  // both confirmations below it are the shared frame — see its header for
  // why the pieces below are ai's and not the frame's.
  return (
    <ChallengeFrame
      resource={resource}
      categoryEditor={categoryEditor}
      moduleSettings={moduleSettings}
      knob={knob}
      newEditor={newAiChallengeEditor}
      editorFromRow={editorFromAiChallenge}
      deleteConfirm={aiChallengeDeleteConfirm}
      meta={(row) => (
        <>
          {row.challenge.points} pt
          {row.challenge.points === 1 ? "" : "s"} · {AI_MODE_LABELS[row.challenge.mode]}
        </>
      )}
      Form={AiChallengeForm}
      onRetry={() => void resource.reload()}
      panelIntro={
        <>
          {/* Once, for the whole board (UX audit F5) — every row used to
              repeat these three URLs. */}
          <AiEndpointsBlock origin={origin} />

          {/* …and what the far end does with them. Collapsed: it is read once,
              while the external site is being wired up, and never again. */}
          <AiExternalSetup origin={origin} />
        </>
      }
      panelNotice={
        // Rotate errors are global rather than per-row, same as every other
        // write in this component (listError, categoryError, deleteError) —
        // an organizer only ever has one rotate in flight at a time.
        rotateError && <p className="text-sm text-[#e53e3e]">{rotateError}</p>
      }
      rowExtra={
        // The integration disclosure under each row — the flag and signing
        // key stay OUT of the list itself: the flag appears only once the
        // organizer opens the edit form, and the signing key is masked by
        // default inside this panel (Reveal is an explicit click). The raw
        // key is absent from the row's markup until then, never sitting
        // exposed on a panel that might be on a projector.
        (row) => (
          <AdminAiIntegration
            challenge={row.challenge}
            signingKey={row.signingKey}
            pending={rotatingId === row.challenge.id}
            onRotate={() => rotateSigningKey(row.challenge.id)}
          />
        )
      }
    />
  );
}
