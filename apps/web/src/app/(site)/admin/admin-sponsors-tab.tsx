"use client";

// Organizer authoring surface for sponsors (issue #405). Self-contained, like
// admin-admins-tab.tsx: it owns its own fetch/pending/error state rather than
// threading through admin-controls' settings-patch `apply` helper, because it
// talks to a different endpoint with a different shape (a list of records,
// not a settings patch).
//
// This file is the network and state layer only — the list (sponsor-list.tsx)
// and the add/edit dialog (sponsor-editor-dialog.tsx) are pure components it
// hands data and callbacks to. That split is what makes them testable: this
// layer's `useEffect` fetch never runs under `renderToStaticMarkup`, so a
// list that owned its own loading would be untestable without a DOM.
//
// Ordering is the `reorder` endpoint, one click per step, applied optimistically
// and rolled back if the write is refused. It replaced a raw `order` number
// box inside the edit form — which meant opening a record to move it, and
// which left the reorder endpoint that shipped with the feature unused.

import { useCallback, useEffect, useState } from "react";
import ConfirmModal from "@/components/confirm-modal";
import { generateChallengeId } from "@/lib/classic-keys";
import { movedSponsorOrder, SPONSOR_LOGO_SIZES, type SponsorLogoSize } from "@/lib/sponsors-keys";
import type { AdminSettings } from "@/lib/admin-store";
import AdminSelectField from "@/components/admin-select-field";
import type { FieldStatus } from "@/components/admin-number-field";
import SponsorList, { type SponsorRecord } from "./sponsor-list";
import SponsorEditorDialog, { type SponsorDraft } from "./sponsor-editor-dialog";

const LOGO_SIZE_LABEL: Record<SponsorLogoSize, string> = { sm: "Small", md: "Medium", lg: "Large" };
const LOGO_SIZE_OPTIONS = SPONSOR_LOGO_SIZES.map((v) => ({ value: v, label: LOGO_SIZE_LABEL[v] }));

/** Which dialog is open. `{ sponsor: null }` is Add; a record is Edit. Held as
 *  one value rather than an `editingId` plus a boolean so "adding" and
 *  "editing nothing" cannot both be true. */
type EditorState = { sponsor: SponsorRecord | null } | null;

export default function AdminSponsorsTab({
  settings,
  settingsPending,
  applyField,
  statusOf,
}: {
  settings: AdminSettings;
  /** Named apart from the CRUD flow's own `pending` below — this gates only
   *  the logo-size field, not the sponsor list's add/edit/delete/reorder. */
  settingsPending: boolean;
  applyField: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  statusOf: (key: string) => FieldStatus;
}) {
  const [rows, setRows] = useState<SponsorRecord[] | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SponsorRecord | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/sponsors")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { sponsors?: SponsorRecord[]; error?: string };
        if (!live) return;
        if (!res.ok) setError(data.error ?? "Could not load sponsors");
        else setRows(data.sponsors ?? []);
      })
      .catch(() => {
        if (live) setError("Could not load sponsors");
      });
    return () => {
      live = false;
    };
  }, []);

  const openEditor = useCallback((sponsor: SponsorRecord | null) => {
    setEditor({ sponsor });
    setEditorError(null);
    setError(null);
    setNotice(null);
  }, []);

  async function submit(draft: SponsorDraft) {
    setPending(true);
    setEditorError(null);
    setNotice(null);
    try {
      const id = draft.id || generateChallengeId(draft.name);
      // A new sponsor lands at the end of the list; an edited one keeps the
      // position it already has. Ordering is the arrows' job, never this
      // form's — the two would otherwise disagree about what "order" means.
      const order = editor?.sponsor?.order ?? rows?.length ?? 0;
      const res = await fetch("/api/admin/sponsors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, id, order }),
      });
      const data = (await res.json().catch(() => ({}))) as { sponsor?: SponsorRecord; error?: string };
      if (!res.ok || !data.sponsor) {
        setEditorError(data.error ?? "Request failed");
        return;
      }
      const saved = data.sponsor;
      setRows((prev) => {
        const next = (prev ?? []).filter((r) => r.id !== saved.id);
        next.push(saved);
        next.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        return next;
      });
      setNotice(`${saved.name} saved.`);
      setEditor(null);
    } catch {
      setEditorError("Request failed");
    } finally {
      setPending(false);
    }
  }

  async function move(id: string, delta: -1 | 1) {
    const current = rows ?? [];
    const orderedIds = movedSponsorOrder(
      current.map((r) => r.id),
      id,
      delta,
    );
    // Null means the move changes nothing — an edge row, or an id that is no
    // longer in the list. Posting it anyway would spend a write and an
    // audit-log line claiming an organizer reordered something.
    if (!orderedIds) return;
    const previous = current;
    const byId = new Map(current.map((r) => [r.id, r]));
    // Optimistic: the arrows are the one control here that an organizer
    // clicks repeatedly, and a round trip per step would make the list lag
    // behind the pointer. The rollback below is what keeps that honest.
    setRows(orderedIds.map((rid, i) => ({ ...byId.get(rid)!, order: i })));
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/sponsors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reorder: orderedIds }),
      });
      const data = (await res.json().catch(() => ({}))) as { sponsors?: SponsorRecord[]; error?: string };
      if (!res.ok) {
        setRows(previous);
        setError(data.error ?? "Could not reorder sponsors");
        return;
      }
      // Prefer the server's own list: it re-sorts and re-numbers, and this is
      // the moment the optimistic guess either was right or is corrected.
      if (data.sponsors) setRows(data.sponsors);
    } catch {
      setRows(previous);
      setError("Could not reorder sponsors");
    } finally {
      setPending(false);
    }
  }

  async function doDelete(row: SponsorRecord) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/sponsors", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id));
      setNotice(`${row.name} removed.`);
    } catch {
      setError("Request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-mono text-sm text-white">Sponsors</h3>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">
              Recognition only — name, logo, link, a short blurb. Renders on the landing page, the footer, /sponsors and
              the leaderboard&apos;s projector display whenever this list is non-empty. Logos must be PNG, JPEG or WebP;
              SVG is rejected (it can run script when opened directly). Prefer a transparent background — JPEG has none,
              so its own shows as a solid rectangle against the site&apos;s dark theme.
            </p>
          </div>
          <button
            type="button"
            disabled={pending || rows === null}
            onClick={() => openEditor(null)}
            className="flex-none rounded-md border border-[#2563eb]/45 px-3 py-1.5 font-mono text-xs text-white transition-colors hover:bg-white/[0.06] disabled:opacity-40"
          >
            + Add sponsor
          </button>
        </div>

        <div className="mt-4 rounded-md border border-white/10 bg-[#12121e] p-4">
          <AdminSelectField
            id="sponsor-logo-size"
            label="Sponsor logo size"
            help="How big sponsor logos render on the landing page's credit row and on the leaderboard's projector display (?display=1). The /sponsors page keeps its own fixed size."
            value={settings.sponsorLogoSize ?? "md"}
            options={LOGO_SIZE_OPTIONS}
            disabled={settingsPending}
            status={statusOf("sponsorLogoSize")}
            onChange={(next) => void applyField("sponsorLogoSize", { sponsorLogoSize: next }, "Sponsor logo size")}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-[#e53e3e]">
            {error}
          </p>
        )}
        {notice && !error && <p className="mt-3 text-sm text-[#22c55e]">{notice}</p>}

        <SponsorList
          rows={rows ?? []}
          loading={rows === null && !error}
          pending={pending}
          onMove={(id, delta) => void move(id, delta)}
          onEdit={(sponsor) => openEditor(sponsor)}
          onDelete={(sponsor) => setDeleteTarget(sponsor)}
        />
      </div>

      {editor && (
        // Keyed so switching straight from one row's Edit to another's
        // remounts the dialog, and its draft starts from the row actually
        // being edited rather than the previous one's values.
        <SponsorEditorDialog
          key={editor.sponsor?.id ?? "new"}
          sponsor={editor.sponsor}
          pending={pending}
          error={editorError}
          onSubmit={(draft) => void submit(draft)}
          onCancel={() => setEditor(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title={`Delete "${deleteTarget.name}"?`}
          body="This removes the sponsor and its logo everywhere on the site immediately."
          confirmLabel="Delete sponsor"
          danger
          pending={pending}
          onConfirm={() => {
            const row = deleteTarget;
            setDeleteTarget(null);
            void doDelete(row);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
