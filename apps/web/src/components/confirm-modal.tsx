"use client";

// Reusable confirmation dialog for disruptive admin actions. Two modes:
//   - plain (impactful, reversible): one-click Confirm.
//   - requireType set (destructive, irreversible): Confirm stays disabled until
//     the operator types the exact phrase, so a wipe can't be a single misclick.
// Display + gating only; the caller owns the action and its pending state.
//
// The dialog mechanics — overlay, focus in/out, Tab trap, Escape — live in
// ModalDialog, which the sponsor editor shares. What is left here is this
// dialog's own contract: the phrase gate and the two buttons.

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import ModalDialog from "@/components/modal-dialog";

// Mount this only while open (`{confirm && <ConfirmModal .../>}`) so each open is
// a fresh mount — the typed-phrase state resets naturally, no effect needed.
export type ConfirmModalProps = {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /** When set, the operator must type this exact string to enable Confirm. */
  requireType?: string;
  /** Red styling for destructive actions. */
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirm",
  requireType,
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const typeOk = !requireType || typed === requireType;
  const confirmDisabled = pending || !typeOk;
  const accent = danger ? "bg-[#e53e3e] hover:bg-[#e53e3e]" : "bg-[#2563eb] hover:bg-[#1d4ed8]";

  return (
    <ModalDialog
      title={title}
      danger={danger}
      pending={pending}
      onCancel={onCancel}
      // The phrase box when there is one; ModalDialog falls back to the panel
      // itself otherwise. Never `autoFocus` — see the effect it would break,
      // documented on ModalDialog's focus effect.
      initialFocusRef={requireType ? inputRef : undefined}
    >
      <div className="mt-2 text-sm text-zinc-300">{body}</div>

      {requireType && (
        <label className="mt-4 block">
          <span className="block text-xs text-muted">
            Type <code className="rounded bg-white/10 px-1 text-white">{requireType}</code> to confirm
          </span>
          <input
            ref={inputRef}
            value={typed}
            disabled={pending}
            onChange={(e) => setTyped(e.target.value)}
            className="mt-1 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white focus-visible:border-[#e53e3e]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          />
        </label>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${accent}`}
        >
          {pending ? "Working…" : confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}
