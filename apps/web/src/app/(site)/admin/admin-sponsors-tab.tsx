"use client";

// Organizer authoring surface for sponsors (issue #405). Self-contained, like
// admin-admins-tab.tsx: it owns its own fetch/pending/error state rather than
// threading through admin-controls' settings-patch `apply` helper, because it
// talks to a different endpoint with a different shape (a list of records,
// not a settings patch).
//
// Deliberately simpler than the classic/quiz/ai content panels: there is no
// drag-reorder widget or draft-guard here, only a plain `order` number field
// per row — sponsors are a handful of records an organizer sets up once
// before an event, not a board contestants watch update live.

import { useEffect, useState } from "react";
import ConfirmModal from "@/components/confirm-modal";
import { generateChallengeId } from "@/lib/classic-keys";
import { SPONSOR_LOGO_MAX, type SponsorTier } from "@/lib/sponsors-keys";

type Sponsor = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  order: number;
  logo: { type: string; w: number; h: number } | null;
};

type Draft = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  order: number;
  logoBase64?: string;
  logoType?: string;
  clearLogo?: boolean;
};

const EMPTY_DRAFT: Draft = { id: "", name: "", url: "", blurb: "", tier: "community", order: 0 };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<type>;base64," prefix FileReader.readAsDataURL adds.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function AdminSponsorsTab() {
  const [rows, setRows] = useState<Sponsor[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Sponsor | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/sponsors")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { sponsors?: Sponsor[]; error?: string };
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

  function startEdit(row: Sponsor) {
    setEditingId(row.id);
    setDraft({ id: row.id, name: row.name, url: row.url, blurb: row.blurb, tier: row.tier, order: row.order });
    setError(null);
    setNotice(null);
  }

  function startNew() {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT, order: rows?.length ?? 0 });
    setError(null);
    setNotice(null);
  }

  async function onFileChange(file: File | null) {
    if (!file) return;
    // Client-side pre-check only — mirrors, but does not replace, the
    // store's own magic-byte sniff (sponsors-store.ts): this just saves an
    // organizer a round trip on an obviously oversized file.
    if (file.size > SPONSOR_LOGO_MAX) {
      setError(`Logo must be at most ${SPONSOR_LOGO_MAX} bytes — this file is ${file.size}.`);
      return;
    }
    const data = await fileToBase64(file);
    setDraft((d) => ({ ...d, logoBase64: data, logoType: file.type, clearLogo: undefined }));
  }

  async function submit() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const id = editingId ?? draft.id ?? generateChallengeId(draft.name);
      const res = await fetch("/api/admin/sponsors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, id }),
      });
      const data = (await res.json().catch(() => ({}))) as { sponsor?: Sponsor; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      setRows((prev) => {
        const existing = prev ?? [];
        const next = existing.filter((r) => r.id !== data.sponsor!.id);
        next.push(data.sponsor!);
        next.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        return next;
      });
      setNotice(`${data.sponsor!.name} saved.`);
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
    } catch {
      setError("Request failed");
    } finally {
      setPending(false);
    }
  }

  async function doDelete(row: Sponsor) {
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
        <h3 className="font-mono text-sm text-white">Sponsors</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Recognition only — name, logo, link, a short blurb. Renders on the landing page, the
          footer, and /sponsors whenever this list is non-empty. Logos must be PNG or WebP; SVG is
          rejected (it can run script when opened directly).
        </p>

        {error && (
          <p role="alert" className="mt-3 text-sm text-[#e53e3e]">
            {error}
          </p>
        )}
        {notice && !error && <p className="mt-3 text-sm text-[#22c55e]">{notice}</p>}

        <form
          className="mt-4 flex flex-col gap-3 rounded-md border border-white/10 bg-[#12121e] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                required
                maxLength={80}
                className="rounded-md border border-white/10 bg-[#1a1a2e] px-3 py-1.5 text-sm text-zinc-200"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              URL (https only)
              <input
                type="url"
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                required
                placeholder="https://example.com"
                className="rounded-md border border-white/10 bg-[#1a1a2e] px-3 py-1.5 text-sm text-zinc-200"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Blurb
            <textarea
              value={draft.blurb}
              onChange={(e) => setDraft((d) => ({ ...d, blurb: e.target.value }))}
              maxLength={280}
              rows={2}
              className="rounded-md border border-white/10 bg-[#1a1a2e] px-3 py-1.5 text-sm text-zinc-200"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Tier
              <select
                value={draft.tier}
                onChange={(e) => setDraft((d) => ({ ...d, tier: e.target.value as SponsorTier }))}
                className="rounded-md border border-white/10 bg-[#1a1a2e] px-3 py-1.5 text-sm text-zinc-200"
              >
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
                <option value="community">Community</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Order
              <input
                type="number"
                value={draft.order}
                onChange={(e) => setDraft((d) => ({ ...d, order: Number(e.target.value) }))}
                className="w-24 rounded-md border border-white/10 bg-[#1a1a2e] px-3 py-1.5 text-sm text-zinc-200"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Logo (PNG or WebP)
              <input
                type="file"
                accept="image/png,image/webp"
                onChange={(e) => void onFileChange(e.target.files?.[0] ?? null)}
                className="text-xs text-zinc-400"
              />
            </label>
            {editingId && (
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={draft.clearLogo === true}
                  onChange={(e) => setDraft((d) => ({ ...d, clearLogo: e.target.checked, logoBase64: undefined }))}
                />
                Remove logo
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending || draft.name.trim() === "" || draft.url.trim() === ""}
              className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-xs text-zinc-200 transition-colors hover:border-[#2563eb]/45 hover:text-white disabled:opacity-40"
            >
              {editingId ? "Save sponsor" : "Add sponsor"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={startNew}
                className="rounded-md border border-white/10 px-3 py-1.5 font-mono text-xs text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        <ul className="mt-4 flex flex-col gap-1">
          {(rows ?? []).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-1">
              <span className="flex min-w-0 items-center gap-2 font-mono text-sm text-zinc-200">
                <span className="truncate">{row.name}</span>
                <span className="flex-none rounded bg-white/[0.06] px-1.5 py-0.5 text-xs uppercase text-zinc-400">
                  {row.tier}
                </span>
                {!row.logo && <span className="flex-none text-xs text-[#d4a017]">no logo</span>}
              </span>
              <span className="flex flex-none gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => startEdit(row)}
                  className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400 hover:text-white disabled:opacity-40"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setDeleteTarget(row)}
                  className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400 transition-colors hover:border-[#e53e3e]/50 hover:text-[#e53e3e] disabled:opacity-40"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
          {rows !== null && rows.length === 0 && (
            <li className="py-1 text-sm text-muted">No sponsors yet — this event ships zero sponsor pixels.</li>
          )}
          {rows === null && !error && <li className="py-1 text-sm text-muted">Loading…</li>}
        </ul>
      </div>

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
