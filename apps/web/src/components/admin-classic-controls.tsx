"use client";

// The Jeopardy module's admin section: the submission-cooldown knob plus
// full challenge authoring (add/edit/reorder/delete) and category management,
// rendered in place of admin-controls.tsx's old "No settings for this module
// yet." placeholder for the classic module. Modeled directly on
// admin-quiz-controls.tsx — same shape of problem (list, drag-sort, keyboard
// reorder, editor form, delete confirmation) — with the differences classic's
// own shape forces:
//
//   - No choices/correct answer. A challenge has a category (drawn from an
//     organizer-managed list), a Markdown description, a point value, and a
//     flag.
//   - The wire contract is THREE payload shapes on ONE endpoint
//     (`POST /api/admin/classic`), dispatched by the server on exact key set:
//     `{categories: string[]}` (exactly one key) replaces the category list;
//     `{import: <raw text>}` (exactly one key) bulk-imports a pasted/uploaded
//     bundle, parsed and validated by `parseBundle` before anything is
//     written; anything else is parsed as a challenge-plus-flag upsert
//     against `CHALLENGE_KEYS` (see that route's header comment). The shared
//     `useCategoryEditor` (components/admin) builds every categories POST as
//     exactly `{categories}` and nothing else — a stray extra key would fall
//     through to the next parser in line and 400.
//   - Categories can be removed only while nothing references them. The
//     store itself does not enforce this (`setCategories` just validates and
//     dedupes the list), so the refusal lives here, client-side, computed
//     from the challenge list this component already holds.
//
// Settings: `classicCooldownSecInput` reuses `commitNumber` from
// admin-controls.tsx exactly like the quiz retry knobs — passed down as a
// prop, already bound to that component's `settings`/`apply` state.
//
// Challenges: this component owns its own fetch of GET /api/admin/classic and
// its own add/edit/reorder/delete state, independent of the settings
// machinery above. `initialChallenges`/`initialCategories` seed the lists
// synchronously (used by tests, which render with `renderToStaticMarkup` and
// so never run the mount-time fetch below); in the browser they are just the
// pre-hydration paint, immediately replaced by a fresh fetch.
//
// No id field, ever. A challenge id is generated from its title
// (`generateChallengeId`, in classic-keys.ts) when a NEW challenge is saved.
// It is the field name in `ctf:classic:challenges`/`ctf:classic:flag`/
// `ctf:classic:flagnorm` AND the reference every contestant's
// `ctf:classic:solves:<login>` row is recorded against, so on an EXISTING
// challenge it is immutable — changing it would orphan every solve already
// banked against the old one. `ChallengeDraft` — the thing the form edits —
// has NO id field at all, mirroring `QuestionDraft`.
//
// The ORDER is written from list position, same as quiz: organizers drag
// rows (or use the per-row Move up/Move down buttons — the keyboard-operable
// path, and not optional). `reorderChallenges` recomputes `order` from the
// resulting positions and the changed rows are POSTed back.
//
// Secrecy: this component DOES hold the flag, and that is deliberate.
// `GET /api/admin/classic` is behind `requireAdmin` and returns
// `listChallengesForAdmin()`'s output — one `AdminChallenge`
// (`{ challenge, flag }`) per challenge — so opening an existing challenge
// for editing prefills the flag currently in force. The alternative — an
// edit form that starts blank — is worse than the leak it avoids: an
// organizer fixing a typo would have to retype the whole flag from memory,
// and getting it wrong silently redefines what counts as solved for every
// contestant, with no diff and no warning. Anyone through the admin gate can
// already rewrite or delete the flag outright, so withholding it here buys
// nothing. The flag INPUT is still masked (`type="password"`, reveal toggle)
// because an organizer editing this panel may well be screen-sharing it.
//
// What has NOT changed: the contestant path is flagless, absolutely. `/flags`
// calls `listChallenges()`, which never reads `ctf:classic:flag` or
// `ctf:classic:flagnorm`, and the `Challenge` type it returns has nowhere to
// put a flag even if it tried. `AdminChallenge` is deliberately NOT
// assignable to `Challenge` (see classic-store.ts) — reaching the public half
// takes an explicit `.challenge`, so a record from THIS component cannot be
// handed to a contestant-facing component by mistake; it's a compile error,
// not a code-review catch.
//
// Deletion changes live event data mid-flight — the challenge disappears from
// every contestant's board and can no longer be submitted against — so it is
// gated behind the same `ConfirmModal` + `requireType` pattern the master
// reset and quiz's question delete use: Confirm stays disabled until the
// organizer types the challenge's own TITLE. `ConfirmModal` reads an EMPTY
// `requireType` as "no confirmation required" (see its own comment), so a
// challenge with a blank/whitespace-only title would delete on one click if
// the phrase were derived from the title alone — `confirmPhraseFromTitle`
// falls back to the challenge's id (always non-empty, `CLASSIC_ID_RE`) for
// exactly that case.
//
// What deletion does NOT do: it does not clear contestant history. Points
// already banked for the challenge stay on the leaderboard, because
// `deleteChallenge` removes only the challenge and its flag rows (see its doc
// comment in classic-store.ts). Clearing banked points is the master reset's
// job. The confirm copy below says so in as many words; keep the two in step.
//
// The pure model (types, validation, payload builders, confirmation copy) is
// in admin-classic-model.ts and the form in admin-classic-form.tsx; both are
// re-exported here so tests and callers keep one import path.

import { useEffect, useState } from "react";
import { CLASSIC_COOLDOWN_SEC } from "@/lib/classic-defaults";
// Type-only import: `classic-store.ts` is `server-only`, but a `import type`
// is fully erased at compile time — no runtime import ever reaches the
// client bundle. Never change this to a value import.
import type { AdminChallenge, Challenge, ImportSummary } from "@/lib/classic-store";
import { parseBundle, serializeBundle } from "@/lib/classic-io";
import ConfirmDelete from "@/components/admin/confirm-delete";
import DiscardDraftConfirm from "@/components/admin/discard-draft-confirm";
import ImportPanel from "@/components/admin/import-panel";
import { downloadJson, useBundleImport } from "@/components/admin/use-bundle-import";
import CategoryEditor from "@/components/admin/category-editor";
import { useCategoryEditor } from "@/components/admin/use-category-editor";
import SortableList from "@/components/admin/sortable-list";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import type { ModuleInventory } from "@/components/admin-module-setup";
import AdminNumberField, { type FieldStatus } from "@/components/admin-number-field";
import AdminSettingsCard, { type ModuleSettingsSlot } from "@/components/admin/settings-card";
import { ChallengeForm } from "@/components/admin-classic-form";
import {
  CHALLENGE_ROWS,
  type ChallengeEditor,
  type ChallengePayload,
  categoryUsageCount,
  challengeDeleteConfirm,
  classicInventory,
  describeClassicError,
  editorFromChallenge,
  exportBundleFrom,
  formatImportSummary,
  newChallengeEditor,
  payloadFromEditor,
  payloadFromRow,
} from "@/components/admin-classic-model";

export * from "@/components/admin-classic-model";
export { ChallengeForm } from "@/components/admin-classic-form";

type NumericSettingKey = "classicCooldownSec";

export type AdminClassicControlsProps = {
  /** Parent-wide "a settings POST is in flight" flag — shared with every
   *  other section's inputs, same as the quiz retry knobs. */
  pending: boolean;
  classicCooldownSecInput: string;
  setClassicCooldownSecInput: (v: string) => void;
  commitNumber: (key: NumericSettingKey, raw: string, reset: (v: string) => void, label: string) => void;
  /** The shell's per-field save status, by stored key (UX audit F2). Optional
   *  so a static render without a shell still works; idle when absent. */
  statusOf?: (key: string) => FieldStatus;
  /** The module screen's settings card slot (identity editor + Hints link);
   *  absent, the knob renders bare — see components/admin/settings-card.tsx. */
  moduleSettings?: ModuleSettingsSlot;
  /** Test/first-paint seed only — see header comment. */
  initialChallenges?: AdminChallenge[];
  /** Seeds the loaded flag — same test seam as the two above. */
  initialLoaded?: boolean;
  initialCategories?: string[];
  /** Reports the board's size to the shell for the setup checklist above this
   *  panel — after the mount-time fetch has settled, never from the seed. */
  onInventory?: (inventory: ModuleInventory) => void;
};

export default function AdminClassicControls({
  pending,
  classicCooldownSecInput,
  setClassicCooldownSecInput,
  commitNumber,
  statusOf = () => ({ state: "idle" }),
  moduleSettings,
  initialChallenges = [],
  initialCategories = [],
  initialLoaded = false,
  onInventory,
}: AdminClassicControlsProps) {
  // The board, the category list, the open editor, the delete target and
  // every write over them live in the shared resource hook
  // (components/admin/use-admin-resource.ts). What is classic-shaped is the
  // config: the endpoint, where a row keeps its id/order, how the route's
  // replies map to rows, and the payload builders above. The seeds are the
  // first paint; the hook's mount-time GET replaces them in the browser
  // (never under `renderToStaticMarkup`).
  const resource = useAdminResource<AdminChallenge, Challenge, ChallengeEditor, ChallengePayload>({
    endpoint: "/api/admin/classic",
    describeError: describeClassicError,
    rows: CHALLENGE_ROWS,
    parseList: (data) => ({
      rows: Array.isArray(data.challenges) ? (data.challenges as AdminChallenge[]) : [],
      categories: Array.isArray(data.categories) ? (data.categories as string[]) : [],
    }),
    loadErrorMessage: "Couldn't load challenges — check your connection and try again.",
    // The route echoes the STORED (trimmed) flag alongside the challenge;
    // falling back to the payload's own flag would leave the list holding
    // something the store never actually wrote.
    parseUpsert: (data, payload) => {
      const challenge = data.challenge as Challenge | undefined;
      if (!challenge) return null;
      return { challenge, flag: (data.flag as string | undefined) ?? payload.flag, hint: (data.hint as string | null | undefined) ?? null };
    },
    toPayload: payloadFromEditor,
    rowPayload: payloadFromRow,
    initialRows: initialChallenges,
    initialLoaded,
    initialCategories,
    // A summary of a write does not outlive the next write (#127).
    onWrite: () => bundleImport.retire(),
  });
  const { rows: challenges, categories, loaded, listError, editing, formPending, deleteTarget, reorderPending, nextOrder } = resource;
  const [flagRevealed, setFlagRevealed] = useState(false);

  // Category editing (input, in-flight flag, refusal) and its writes; the
  // list itself is the resource's because the same GET and a bulk import own
  // it.
  const categoryEditor = useCategoryEditor({
    endpoint: "/api/admin/classic",
    describeError: describeClassicError,
    categories,
    setCategories: resource.setCategories,
    usageCount: (name) => categoryUsageCount(challenges, name),
    // A rename rewrites every challenge in the category, so the rows on
    // screen still carry the old name until the list is re-read. Without
    // this the panel keeps grouping them under a heading the store no
    // longer has.
    afterRename: resource.reload,
  });

  // The bulk import/export flow (textarea, file pick, `{import}` POST,
  // after-import summary) — see components/admin/use-bundle-import.ts. On
  // success both lists are re-read from the server, never hand-patched.
  const bundleImport = useBundleImport<ImportSummary>({
    endpoint: "/api/admin/classic",
    describeError: describeClassicError,
    parse: parseBundle,
    parseSummary: (reply) => ({ created: reply.created ?? 0, updated: reply.updated ?? 0, categories: reply.categories ?? 0 }),
    afterImport: resource.reload,
  });

  // Report upward whenever the board changes, once it is real. A report to
  // the parent's subscriber, not a setState of this component's own.
  useEffect(() => {
    if (loaded) onInventory?.(classicInventory(challenges, categories));
  }, [loaded, challenges, categories, onInventory]);

  const confirmCopy = deleteTarget ? challengeDeleteConfirm(deleteTarget) : null;

  const knob = (
    <AdminNumberField
      id="classic-cooldown-sec"
      label="Submission cooldown (sec)"
      help="Seconds a contestant must wait between flag submissions on the same challenge. 0 = no cooldown."
      value={classicCooldownSecInput}
      placeholder={String(CLASSIC_COOLDOWN_SEC)}
      disabled={pending}
      status={statusOf("classicCooldownSec")}
      onChange={setClassicCooldownSecInput}
      onBlur={() =>
        commitNumber("classicCooldownSec", classicCooldownSecInput, setClassicCooldownSecInput, "Submission cooldown (sec)")
      }
    />
  );

  return (
    <>
      {moduleSettings ? (
        <AdminSettingsCard identity={moduleSettings.identity} onHints={moduleSettings.onHints}>
          {knob}
        </AdminSettingsCard>
      ) : (
        knob
      )}

      <CategoryEditor
        loading={!resource.loaded}
        categories={categories}
        input={categoryEditor.input}
        error={categoryEditor.error}
        pending={categoryEditor.pending}
        onInput={categoryEditor.setInput}
        onAdd={categoryEditor.add}
        onRemove={categoryEditor.remove}
        onMove={categoryEditor.move}
        renaming={categoryEditor.renaming}
        renameInput={categoryEditor.renameInput}
        onRenameInput={categoryEditor.setRenameInput}
        onStartRename={categoryEditor.startRename}
        onCancelRename={categoryEditor.cancelRename}
        onCommitRename={categoryEditor.commitRename}
      />

      <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-white">Challenges</span>
          <button
            type="button"
            disabled={formPending || categories.length === 0}
            onClick={() => {
              setFlagRevealed(false);
              resource.openEditor(newChallengeEditor(nextOrder, categories[0] ?? ""));
            }}
            className="rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
          >
            Add challenge
          </button>
        </div>

        {listError && <p className="text-sm text-[#e53e3e]">{listError}</p>}

        {/* The collapsed list shows the public half only — the flag appears
            when the organizer opens the edit form, not on a panel that might
            be on a projector. */}
        <SortableList<AdminChallenge>
          rows={challenges}
          keyOf={(row) => row.challenge.id}
          titleOf={(row) => row.challenge.title}
          // Grouped by category, as contestants see the board; the category
          // is the heading, so the meta line does not repeat it.
          groupOf={(row) => row.challenge.category}
          groups={categories}
          meta={(row) => (
            <>
              {row.challenge.points} pt
              {row.challenge.points === 1 ? "" : "s"}
            </>
          )}
          intro="Drag a challenge to reorder it, or use Move up / Move down from its ⋯ menu. Contestants see them in this order within each category."
          emptyText="No challenges yet."
          loading={!resource.loaded}
          reorderPending={reorderPending}
          onMove={(from, to) => void resource.move(from, to)}
          onEdit={(row) => {
            setFlagRevealed(false);
            resource.openEditor(editorFromChallenge(row));
          }}
          onDelete={(row) => resource.requestDelete(row.challenge)}
        />
      </div>

      <ImportPanel
        exportDescription="Downloads every challenge currently on the board as one JSON file, flags included."
        exportLabel="Export challenges"
        exportDisabled={challenges.length === 0}
        onExport={() => downloadJson(serializeBundle(exportBundleFrom(challenges, categories)), "classic-challenges.json")}
        notice={
          <>
            Import never deletes existing challenges — anything already on the board that isn&rsquo;t in the file
            is left untouched. Categories the bundle mentions are added to the existing list, never used to
            replace it.
          </>
        }
        text={bundleImport.text}
        pending={bundleImport.pending}
        clientErrors={bundleImport.clientErrors}
        importErrors={bundleImport.importErrors}
        summary={bundleImport.result ? formatImportSummary(bundleImport.result) : null}
        canImport={bundleImport.canImport}
        onText={bundleImport.setText}
        onFile={(e) => void bundleImport.handleFile(e)}
        onSubmit={() => void bundleImport.submit()}
      />

      {editing && (
        <ChallengeForm
          key={editing.mode === "edit" ? editing.id : "new"}
          editor={editing}
          categories={categories}
          pending={formPending}
          error={resource.formError}
          flagRevealed={flagRevealed}
          setFlagRevealed={setFlagRevealed}
          onChange={(draft) => resource.setEditing({ ...editing, draft })}
          onCancel={resource.cancelEditor}
          onSubmit={() => void resource.submitEditor(editing)}
        />
      )}

      {/* Audit F17: Edit on another row, or Add, parks the new editor
          here rather than replacing a half-written draft in silence. */}
      {resource.pendingEditor && (
        <DiscardDraftConfirm
          noun="challenge"
          onConfirm={resource.confirmDraftSwitch}
          onCancel={resource.cancelDraftSwitch}
        />
      )}

      {deleteTarget && confirmCopy && (
        <ConfirmDelete
          copy={confirmCopy}
          error={resource.deleteError}
          pending={resource.deletePending}
          onConfirm={() => void resource.remove(deleteTarget.id)}
          onCancel={resource.cancelDelete}
        />
      )}
    </>
  );
}
