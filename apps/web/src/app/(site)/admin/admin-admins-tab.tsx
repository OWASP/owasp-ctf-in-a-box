"use client";

// The admin roster (ADR 73): who holds a grant, removing one, and issuing a
// one-time code that makes another kit account an admin at /admin/claim.
// There is no "add by name" here on purpose: a code is the only way in.
//
// Self-contained on purpose: it owns its own fetch/pending/error state rather
// than threading through admin-controls' `apply`, because it talks to
// different endpoints with a different shape (a set, not a settings patch).

import { useEffect, useState } from "react";
import ConfirmModal from "@/components/confirm-modal";

type AdminRow = { id: string; name: string; self: boolean };

/** What the tab says around a freshly issued code. Exported so the copy is
 *  provable without rendering the stateful view. */
export const ISSUE_HELP =
  "Give this code to the new organizer. They sign in, open /admin/claim and enter it. It works once and expires in 15 minutes.";

/** The line under an issued code. */
export function codeNotice(expiresAt: string): string {
  const at = new Date(expiresAt);
  const when = Number.isNaN(at.getTime()) ? expiresAt : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `This code works once and expires at ${when}. It is shown only here, now.`;
}

/** The confirmation for removing an admin. No `requireType`: another admin
 *  can issue the removed one a new code, and the last admin cannot be removed
 *  at all (the API refuses it). Exported for direct testing. */
export function adminRemoveConfirm(
  target: { id: string; name: string },
  viewerId: string,
): { title: string; body: string; confirmLabel: string } {
  const self = target.id === viewerId;
  return {
    title: self ? "Remove your own admin access?" : `Remove ${target.name} as an admin?`,
    body: self
      ? "You will lose this panel immediately. Another admin can issue you a new code."
      : `${target.name} loses access to this panel immediately. Nothing they have done is undone, and you can issue them a new code at any time.`,
    confirmLabel: "Remove admin",
  };
}

export default function AdminAdminsTab({ viewerId }: { viewerId: string }) {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The admin awaiting a removal confirmation, or null. */
  const [removeTarget, setRemoveTarget] = useState<AdminRow | null>(null);
  /** The code just issued. Component state only, so leaving the tab drops it. */
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // The one legitimate effect here: fetch the current list once, on mount.
  // Every setState is inside a promise callback, never in the effect body.
  useEffect(() => {
    let live = true;
    fetch("/api/admin/admins")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { admins?: AdminRow[]; error?: string };
        if (!live) return;
        if (!res.ok) setError(data.error ?? "Could not load admins");
        else setRows(data.admins ?? []);
      })
      .catch(() => {
        if (live) setError("Could not load admins");
      });
    return () => {
      live = false;
    };
  }, []);

  async function remove(target: AdminRow) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { admins?: AdminRow[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      setRows(data.admins ?? []);
      setNotice(`${target.name} is no longer an admin.`);
    } catch {
      setError("Request failed");
    } finally {
      setPending(false);
    }
  }

  async function issue() {
    setPending(true);
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/codes", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { code?: string; expiresAt?: string; error?: string };
      if (!res.ok || !data.code || !data.expiresAt) {
        setError(data.error ?? "Could not issue a code");
        return;
      }
      setIssued({ code: data.code, expiresAt: data.expiresAt });
    } catch {
      setError("Could not issue a code");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
        <h3 className="font-mono text-sm text-white">Admins</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Organizers are kit accounts that claimed a code. Issue a code to add one; remove one at any time, as long
          as another admin remains.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <button
              type="button"
              disabled={pending}
              onClick={() => void issue()}
              className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-xs text-zinc-200 transition-colors hover:border-[#2563eb]/45 hover:text-white disabled:opacity-40"
            >
              Issue admin code
            </button>
          </div>
          {issued && (
            <div className="rounded-md border border-white/10 bg-[#12121e] p-3">
              <p className="text-sm text-zinc-300">{ISSUE_HELP}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="break-all font-mono text-sm text-white">{issued.code}</code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(issued.code)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                  className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400 transition-colors hover:text-white"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">{codeNotice(issued.expiresAt)}</p>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-[#e53e3e]">
            {error}
          </p>
        )}
        {notice && !error && <p className="mt-3 text-sm text-[#22c55e]">{notice}</p>}

        <ul className="mt-4 flex flex-col gap-1">
          {(rows ?? []).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-1">
              <span className="text-sm text-zinc-200">
                {row.name}
                {row.self && (
                  <span className="ml-2 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs uppercase text-zinc-400">
                    you
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => setRemoveTarget(row)}
                className="rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-zinc-400 transition-colors hover:border-[#e53e3e]/50 hover:text-[#e53e3e] disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
          {rows === null && !error && <li className="py-1 text-sm text-muted">Loading…</li>}
        </ul>
      </div>

      {removeTarget !== null && (
        <ConfirmModal
          {...adminRemoveConfirm(removeTarget, viewerId)}
          danger
          pending={pending}
          onConfirm={() => {
            const target = removeTarget;
            setRemoveTarget(null);
            void remove(target);
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </section>
  );
}
